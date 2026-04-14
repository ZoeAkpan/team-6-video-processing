import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT || 3001)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const VIEW_EVENT_CHANNEL = process.env.VIEW_EVENT_CHANNEL || 'view.started'

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

app.post('/views', async (req, res) => {
  try {
    const { userId, videoId, positionSeconds } = req.body || {}

    const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
    const normalizedVideoId = typeof videoId === 'string' ? videoId.trim() : ''
    const normalizedPositionSeconds = Number(positionSeconds)

    if (!normalizedUserId) {
      return res.status(400).json({
        error: 'userId is required',
      })
    }

    if (!normalizedVideoId) {
      return res.status(400).json({
        error: 'videoId is required',
      })
    }

    if (
      !Number.isFinite(normalizedPositionSeconds) ||
      normalizedPositionSeconds < 0
    ) {
      return res.status(400).json({
        error: 'positionSeconds must be a non-negative number',
      })
    }

    const duplicateResult = await pool.query(
      `
        SELECT
          id,
          user_id,
          video_id,
          position_seconds,
          viewed_at
        FROM view_events
        WHERE user_id = $1
          AND video_id = $2
          AND viewed_at >= NOW() - INTERVAL '30 seconds'
        ORDER BY viewed_at DESC
        LIMIT 1
      `,
      [normalizedUserId, normalizedVideoId]
    )

    if (duplicateResult.rows.length > 0) {
      const existing = duplicateResult.rows[0]

      return res.status(200).json({
        duplicate: true,
        ignored: true,
        userId: existing.user_id,
        videoId: existing.video_id,
        positionSeconds: Number(existing.position_seconds),
        viewedAt: existing.viewed_at,
      })
    }

    const insertResult = await pool.query(
      `
        INSERT INTO view_events (
          user_id,
          video_id,
          position_seconds
        )
        VALUES ($1, $2, $3)
        RETURNING
          id,
          user_id,
          video_id,
          position_seconds,
          viewed_at
      `,
      [normalizedUserId, normalizedVideoId, normalizedPositionSeconds]
    )

    const row = insertResult.rows[0]

    try {
      await redis.publish(
        VIEW_EVENT_CHANNEL,
        JSON.stringify({
          userId: row.user_id,
          videoId: row.video_id,
          positionSeconds: Number(row.position_seconds),
          viewedAt: row.viewed_at,
        })
      )
    } catch (err) {
      console.error('Failed to publish view.started event:', err.message)
    }

    return res.status(201).json({
      duplicate: false,
      ignored: false,
      id: row.id,
      userId: row.user_id,
      videoId: row.video_id,
      positionSeconds: Number(row.position_seconds),
      viewedAt: row.viewed_at,
    })
  } catch (err) {
    console.error('POST /views failed:', err)
    return res.status(500).json({
      error: 'internal server error',
    })
  }
})

app.get('/resume', async (req, res) => {
  try {
    const normalizedUserId =
      typeof req.query.userId === 'string' ? req.query.userId.trim() : ''
    const normalizedVideoId =
      typeof req.query.videoId === 'string' ? req.query.videoId.trim() : ''

    if (!normalizedUserId) {
      return res.status(400).json({
        error: 'userId is required',
      })
    }

    if (!normalizedVideoId) {
      return res.status(400).json({
        error: 'videoId is required',
      })
    }

    const result = await pool.query(
      `
        SELECT
          user_id,
          video_id,
          position_seconds,
          viewed_at
        FROM view_events
        WHERE user_id = $1
          AND video_id = $2
        ORDER BY viewed_at DESC
        LIMIT 1
      `,
      [normalizedUserId, normalizedVideoId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'resume position not found',
        userId: normalizedUserId,
        videoId: normalizedVideoId,
      })
    }

    const row = result.rows[0]

    return res.status(200).json({
      userId: row.user_id,
      videoId: row.video_id,
      positionSeconds: Number(row.position_seconds),
      viewedAt: row.viewed_at,
    })
  } catch (err) {
    console.error('GET /resume failed:', err)
    return res.status(500).json({
      error: 'internal server error',
    })
  }
})

app.use((_req, res) => {
  return res.status(404).json({
    error: 'not found',
  })
})

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down playback-service...`)

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

    app.listen(PORT, () => {
      console.log(`playback-service listening on port ${PORT}`)
    })
  } catch (err) {
    console.error('Failed to start playback-service:', err)
    process.exit(1)
  }
}

start()