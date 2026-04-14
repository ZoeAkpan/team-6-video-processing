import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()

const PORT = Number(process.env.PORT || 3001)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const TRANSCODE_COMPLETE_CHANNEL =
  process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode.complete'
const VIDEO_REJECTED_CHANNEL =
  process.env.VIDEO_REJECTED_CHANNEL || 'video.rejected'
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
    if (pong !== 'PONG') {
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

async function handleTranscodeComplete(rawMessage) {
  let payload

  try {
    payload = JSON.parse(rawMessage)
  } catch (err) {
    await pool.query(
      `
        INSERT INTO moderation_poison_pills (raw_payload, error_message)
        VALUES ($1, $2)
      `,
      [rawMessage, `invalid json: ${err.message}`]
    )
    return
  }

  const videoId =
    typeof payload.videoId === 'string' ? payload.videoId.trim() : ''

  if (!videoId) {
    await pool.query(
      `
        INSERT INTO moderation_poison_pills (raw_payload, error_message)
        VALUES ($1, $2)
      `,
      [rawMessage, 'missing videoId']
    )
    return
  }

  const approved = Math.random() < MODERATION_PASS_RATE
  const status = approved ? 'approved' : 'rejected'
  const reason = approved ? 'passed_automated_review' : 'rejected_automated_review'

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

  if (!approved) {
    await redis.publish(
      VIDEO_REJECTED_CHANNEL,
      JSON.stringify({
        videoId,
        status,
        reason,
        moderatedAt: new Date().toISOString(),
      })
    )
  }
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

    await subscriber.subscribe(TRANSCODE_COMPLETE_CHANNEL, async (message) => {
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