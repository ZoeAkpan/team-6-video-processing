import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()

const PORT = Number(process.env.PORT || 3007)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const TRANSCODE_COMPLETE_EVENT = process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode-complete'
const VIDEO_REJECTED_EVENT = process.env.VIDEO_REJECTED_CHANNEL || 'video-rejected'
const MODERATION_PASS_RATE = Number(process.env.MODERATION_PASS_RATE || 0.8)

const pool = new Pool({
  connectionString: DATABASE_URL,
})

const redis = createClient({
  url: REDIS_URL,
})

const subscriber = createClient({
  url: REDIS_URL,
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

subscriber.on('error', (err) => {
  console.error('Redis subscriber error:', err.message)
})

async function getHealthSnapshot() {
  let db = 'ok'
  let redisStatus = 'ok'

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    db = `error: ${err.message}`
  }

  try {
    const pong = await redis.ping()
    if (pong !== 'PONG' && pong !== "pong") {
      throw new Error(`unexpected ping response: ${pong}`)
    }
  } catch (err) {
    redisStatus = `error: ${err.message}`
  }

  const healthy = db === 'ok' && redisStatus === 'ok'

  const response = {
    healthy,
    body: {
      status: healthy ? 'healthy' : 'unhealthy',
      db,
      redis: redisStatus,
    },
  }

  if (redisStatus === "ok") {
    const lastJobTime = await redis.get("moderation-worker_last_completed_job_time")
    response.body.lastJobCompletedAt = lastJobTime ? lastJobTime : "no completed jobs"
  }

  return response
}

app.get('/health', async (_req, res) => {
  const snapshot = await getHealthSnapshot()
  return res.status(snapshot.healthy ? 200 : 503).json(snapshot.body)
})

app.use((_req, res) => {
  return res.status(404).json({
    error: 'not found',
  })
})

function getValidPayload(raw) {
  // returns parsed JSON if valid, error message if not 
  try {
    const payload = JSON.parse(raw)

    const allowedKeys = [
      "originalFileName",
      "contentType",
      "fileSizeBytes",
      "uploadedBy",
      "fileHash",
      "duration",
      "status",
      "updatedAt"
    ]

    const keys = Object.keys(payload);

    // Check for missing keys
    for (const key of allowedKeys) {
      if (!keys.includes(key)) {
        throw new Error(`Missing field: ${key}`);
      }
    }

    // Check for extra keys
    for (const key of keys) {
      if (!allowedKeys.includes(key)) {
        throw new Error(`Unexpected field: ${key}`);
      }
    }

    // capture just what we need (discard "status" and "updatedAt")
    const {
      originalFileName,
      contentType,
      fileSizeBytes,
      uploadedBy,
      fileHash,
      duration,
    } = payload

    // save into one object
    const video = {
      originalFileName,
      contentType,
      fileSizeBytes,
      uploadedBy,
      fileHash,
      duration,
    }

    return {
      valid: true,
      video
    }

  } catch (error) {
    return {
      valid: false,
      error,
      raw
    }
  }
}

function simulateContentReview(videoData) {
  const approved = Math.random() < MODERATION_PASS_RATE
  const status = approved ? 'approved' : 'rejected'
  const reason = approved ? 'passed_automated_review' : 'rejected_automated_review'

  console.log(`Completed content review for video ${videoData.fileHash}. Result: ${status}`)
  
  return [ approved, status, reason ]
}

async function handleTranscodeComplete(rawMessage) {
  console.log(`Received ${TRANSCODE_COMPLETE_EVENT} with payload: ${rawMessage}`)

  // expected rawMessage format:
  // {
  //   "originalFilename": "demo.mp4",
  //   "contentType": "video/mp4",
  //   "fileSizeBytes": 1000000,
  //   "uploadedBy": "user-123",
  //   "fileHash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  //   "duration": 1,
  //   "status": "complete",
  //   "updatedAt": "2026-04-27T19:16:00.000Z"
  // }

  const result = getValidPayload(rawMessage)

  if (!result.valid) {
    // invalid payload, add to DLQ
    return
  }

  // valid payload, simulate content review and add to db
  const payload = result.video

  const fileHash = payload.fileHash
  
  const [ approved, status, reason ] = simulateContentReview(payload)

  await pool.query(
    `
      INSERT INTO moderation_results (
        fileHash,
        status,
        reason,
      )
      VALUES ($1, $2, $3)
    `,
    [fileHash, status, reason]
  )

  console.log('Moderation recorded to database', { fileHash, status, reason })

  if (!approved) {
    await redis.publish(
      VIDEO_REJECTED_EVENT,
      JSON.stringify({
        fileHash,
        status,
        reason,
        moderatedAt: new Date().toISOString(),
        video: payload
      })
    )
    console.log(`Published ${VIDEO_REJECTED_EVENT} event`)
  }

  // mark time of last successfully processed job for health endpoint
  await redis.set("moderation-worker_last_completed_job_time", new Date().toISOString())
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down moderation-worker...`)

  try {
    if (subscriber.isOpen) {
      await subscriber.quit()
    }
  } catch (err) {
    console.error('Error while closing Redis subscriber:', err.message)
  }

  try {
    if (redis.isOpen) {
      await redis.quit()
    }
  } catch (err) {
    console.error('Error while closing Redis:', err.message)
  }

  try {
    await pool.end()
  } catch (err) {
    console.error('Error while closing Postgres pool:', err.message)
  }

  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

async function start() {
  try {
    await redis.connect()
    await subscriber.connect()
    await pool.query('SELECT 1')

    await subscriber.subscribe(TRANSCODE_COMPLETE_EVENT, async (message) => {
      try {
        await handleTranscodeComplete(message)
      } catch (err) {
        console.error('Moderation processing failed:', err)
      }
    })

    app.listen(PORT, () => {
      console.log(`moderation-worker listening on port ${PORT}`)
    })
  } catch (err) {
    console.error('Failed to start moderation-worker:', err)
    process.exit(1)
  }
}

start()