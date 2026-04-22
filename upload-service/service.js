// code from health endpoint section 

import express from 'express'
import crypto from 'node:crypto'
import pg from 'pg'
import { createClient } from 'redis'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const quotaServiceUrl = process.env.QUOTA_SERVICE_URL ?? 'http://quota-service:3001'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const startTime = Date.now()
app.use(express.json())

async function checkQuota(userId, fileSizeBytes, fileHash) {
  const response = await fetch(`${quotaServiceUrl}/quota/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, fileSizeBytes, fileHash }),
  })

  const payload = await response.json()

  if (!response.ok) {
    const error = new Error(payload.error ?? 'quota check failed')
    error.status = response.status
    throw error
  }

  return payload
}

function normalizeHash(fileHash) {
  return fileHash.trim().toLowerCase()
}

app.get('/health', async (req, res) => {
  const checks = {}
  let healthy = true

  // Check PostgreSQL
  const dbStart = Date.now()
  try {
    await pool.query('SELECT 1')
    checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart }
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  // Check Redis
  const redisStart = Date.now()
  try {
    const pong = await redis.ping()
    if (pong !== 'PONG') throw new Error(`unexpected response: ${pong}`)
    checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart }
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  const body = {
    status: healthy ? 'healthy' : 'unhealthy',
    service: process.env.SERVICE_NAME ?? 'unknown',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  }

  res.status(healthy ? 200 : 503).json(body)
})

app.post('/upload', async (req, res) => {
  const {
    originalFilename,
    contentType,
    fileSizeBytes,
    uploadedBy,
    metadata = {},
  } = req.body ?? {}

  if (!originalFilename || !contentType || !uploadedBy || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    return res.status(400).json({
      error: 'originalFilename, contentType, uploadedBy, and positive numeric fileSizeBytes are required',
    })
  }

// checking for duplicates by seeing if an upload key exists in redis for user. if it does not, set it equal to true with expiry date
const uploadExists = userID => `upload:${userID}`

// generating random id
const uploadId = crypto.randomUUID()
const doesntExist = await redis.set(uploadExists(uploadedBy), uploadId, { NX: true, EX: 400 }) 

// if exists
if (!doesntExist){
  // 409 represents duplicate conflict
  const existingRecord = await redis.get(`upload:${uploadedBy}`)
  const {rows} = await pool.query('SELECT * FROM upload WHERE id = $1', [existingRecord])
  return res.status(200).json({upload: rows[0], message: 'duplicate upload detected'})
}

  try {
    const quota = await checkQuota(uploadedBy, fileSizeBytes)

    if (!quota.allowed) {
      return res.status(403).json({
        error: 'Upload blocked by quota service',
        quota,
      })
    }

    const storageKey = `uploads/${Date.now()}-${originalFilename}`
    const { rows } = await pool.query(
      `INSERT INTO upload (
        id,
        original_filename,
        storage_key,
        content_type,
        file_size_bytes,
        uploaded_by,
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        uploadId,
        originalFilename,
        storageKey,
        contentType,
        fileSizeBytes,
        uploadedBy,
        'pending',
        JSON.stringify(metadata),
      ]
    )

    await redis.hSet(`job:${uploadId}`, {
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
    await redis.expire(`job:${uploadId}`, 24 * 60 * 60) // match worker's 1 day TTL


    await redis.lPush('transcode-jobs', JSON.stringify({
    jobId: uploadId,
    videoId: uploadId, 
    originalFilename,
    contentType,
    fileSizeBytes,
    uploadedBy,
    metadata,
  }))

    return res.status(201).json({
      message: 'Upload accepted',
      upload: rows[0],
      quota,
    })
  } catch (err) {
    return res.status(err.status ?? 500).json({
      error: err.message ?? 'Upload failed',
    })
  } finally {
    await redis.del(uploadExists(uploadedBy))
  }
})

app.listen(port, () => {
  console.log(`upload-service listening on port ${port}`)
})