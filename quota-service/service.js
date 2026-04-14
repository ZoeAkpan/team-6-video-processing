import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT || 3001)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const DEFAULT_UPLOAD_LIMIT_COUNT = Number(process.env.DEFAULT_UPLOAD_LIMIT_COUNT || 10)
const DEFAULT_STORAGE_LIMIT_BYTES = Number(
  process.env.DEFAULT_STORAGE_LIMIT_BYTES || 1073741824
)

const pool = new Pool({
  connectionString: DATABASE_URL,
})

const redis = createClient({
  url: REDIS_URL,
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

async function ensureQuotaRow(userId) {
  await pool.query(
    `
      INSERT INTO quotas (
        user_id,
        upload_count,
        upload_limit_count,
        storage_used_bytes,
        storage_limit_bytes
      )
      VALUES ($1, 0, $2, 0, $3)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId, DEFAULT_UPLOAD_LIMIT_COUNT, DEFAULT_STORAGE_LIMIT_BYTES]
  )

  const result = await pool.query(
    `
      SELECT
        user_id,
        upload_count,
        upload_limit_count,
        storage_used_bytes,
        storage_limit_bytes
      FROM quotas
      WHERE user_id = $1
    `,
    [userId]
  )

  return result.rows[0]
}

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

app.post('/quota/check', async (req, res) => {
  try {
    const { userId, fileSizeBytes } = req.body || {}

    const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
    const requestedFileSizeBytes = Number(fileSizeBytes)

    if (!normalizedUserId) {
      return res.status(400).json({
        error: 'userId is required',
      })
    }

    if (!Number.isFinite(requestedFileSizeBytes) || requestedFileSizeBytes < 0) {
      return res.status(400).json({
        error: 'fileSizeBytes must be a non-negative number',
      })
    }

    const quota = await ensureQuotaRow(normalizedUserId)

    const uploadCount = Number(quota.upload_count)
    const uploadLimitCount = Number(quota.upload_limit_count)
    const storageUsedBytes = Number(quota.storage_used_bytes)
    const storageLimitBytes = Number(quota.storage_limit_bytes)

    const remainingUploadSlots = uploadLimitCount - uploadCount
    const remainingBytes = storageLimitBytes - storageUsedBytes

    const allowedByCount = remainingUploadSlots > 0
    const allowedByStorage = remainingBytes >= requestedFileSizeBytes
    const allowed = allowedByCount && allowedByStorage

    let reason = 'ok'
    if (!allowedByCount) {
      reason = 'upload_count_limit_exceeded'
    } else if (!allowedByStorage) {
      reason = 'storage_limit_exceeded'
    }

    return res.status(200).json({
      allowed,
      reason,
      userId: normalizedUserId,
      requestedFileSizeBytes,
      uploadCount,
      uploadLimitCount,
      remainingUploadSlots,
      storageUsedBytes,
      storageLimitBytes,
      remainingBytes,
    })
  } catch (err) {
    console.error('POST /quota/check failed:', err)
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
  console.log(`Received ${signal}. Shutting down quota-service...`)

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
      console.log(`quota-service listening on port ${PORT}`)
    })
  } catch (err) {
    console.error('Failed to start quota-service:', err)
    process.exit(1)
  }
}

start()
