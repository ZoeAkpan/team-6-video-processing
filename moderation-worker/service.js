import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()

const PORT = Number(process.env.PORT || 3007)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const TRANSCODE_COMPLETE_EVENT = process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode.complete'
const VIDEO_REJECTED_EVENT = process.env.VIDEO_REJECTED_CHANNEL || 'video.rejected'
const MODERATION_PASS_RATE = Number(process.env.MODERATION_PASS_RATE || 0.8)

const pool = new Pool({
  connectionString: DATABASE_URL,
})

const redis = createClient({
  url: REDIS_URL,
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
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

  return {
    healthy,
    body: {
      status: healthy ? 'healthy' : 'unhealthy',
      db,
      redis: redisStatus,
    },
  }
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

function isValidPayload(raw) {
  // will check for poison pills (malformed data) in sprint 3
  return true // just return true for now
}

function simulateContentReview(videoData) {
  const approved = Math.random() < MODERATION_PASS_RATE
  const status = approved ? 'approved' : 'rejected'
  const reason = approved ? 'passed_automated_review' : 'rejected_automated_review'

  console.log(`Completed content review for video ${videoData.videoId}. Result: ${status}`)
  
  return [ approved, status, reason ]
}

async function handleTranscodeComplete(rawMessage) {
  console.log(`Received ${TRANSCODE_COMPLETE_EVENT} with payload: ${rawMessage}`)

  if (!isValidPayload(rawMessage)) {
    // poison pill handling
    // will be done in sprint 3
    return
  }

  const payload = JSON.parse(rawMessage)
  // expected structure:
  // {
  //   jobId,
  //   videoId,
  //   status,
  //   updatedAt,
  //   outputFormats
  // }

  const videoId = payload.videoId
  
  const [ approved, status, reason ] = simulateContentReview(payload)

  await pool.query(
    `
      INSERT INTO moderation_results (
        video_id,
        status,
        reason,
        source_event
      )
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (video_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        source_event = EXCLUDED.source_event,
        moderated_at = NOW()
    `,
    [videoId, status, reason, JSON.stringify(payload)]
  )

  console.log('Moderation recorded to database', { videoId, status, reason })

  if (!approved) {
    await redis.publish(
      VIDEO_REJECTED_EVENT,
      JSON.stringify({
        videoId,
        status,
        reason,
        moderatedAt: new Date().toISOString(),
      })
    )
    console.log(`Published ${VIDEO_REJECTED_EVENT} event`)
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down moderation-worker...`)

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
    await pool.query('SELECT 1')

    await redis.subscribe(TRANSCODE_COMPLETE_EVENT, async (message) => {
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