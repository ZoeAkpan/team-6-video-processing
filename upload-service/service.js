// code from health endpoint section 

import express from 'express'
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

function getFileHash(body) {
  const metadata = body?.metadata ?? {}
  return body?.fileHash ?? metadata.fileHash ?? metadata.file_hash ?? null
}

function uploadLockKey(userId, fileHash) {
  return `upload:${userId}:${fileHash}`
}

async function consumeQuota(userId, fileSizeBytes, fileHash) {
  const response = await fetch(`${quotaServiceUrl}/quota/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, fileSizeBytes, fileHash }),
  })

  const payload = await response.json()

  if (!response.ok) {
    const error = new Error(payload.error ?? 'quota consume failed')
    error.status = response.status
    throw error
  }

  return payload
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

  const fileHash = getFileHash(req.body)
  const normalizedMetadata = { ...metadata, fileHash, file_hash: fileHash }

  if (!originalFilename || !contentType || !uploadedBy || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0 || !fileHash) {
    return res.status(400).json({
      error: 'originalFilename, contentType, uploadedBy, fileHash, and positive numeric fileSizeBytes are required',
    })
  }

const uploadId = crypto.randomUUID()

// 1. persistent duplicate check by fileHash in the database
const { rows: existingUploads } = await pool.query(
  `
  SELECT *
  FROM upload
  WHERE uploaded_by = $1
    AND COALESCE(metadata->>'fileHash', metadata->>'file_hash') = $2
  LIMIT 1
  `,
  [uploadedBy, fileHash]
)

if (existingUploads.length > 0) {
  return res.status(200).json({
    upload: existingUploads[0],
    message: 'duplicate upload detected',
  })
}

// 2. short-lived Redis lock to reduce concurrent duplicate inserts
const lockKey = uploadLockKey(uploadedBy, fileHash)
const lockAcquired = await redis.set(lockKey, uploadId, { NX: true, EX: 400 })

if (!lockAcquired) {
  const { rows } = await pool.query(
    `
    SELECT *
    FROM upload
    WHERE uploaded_by = $1
      AND COALESCE(metadata->>'fileHash', metadata->>'file_hash') = $2
    LIMIT 1
    `,
    [uploadedBy, fileHash]
  )

  if (rows.length > 0) {
    return res.status(200).json({
      upload: rows[0],
      message: 'duplicate upload detected',
    })
  }

  return res.status(409).json({
    error: 'duplicate upload already in progress',
  })
}

  try {
    const quota = await checkQuota(uploadedBy, fileSizeBytes, fileHash)

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
        JSON.stringify(normalizedMetadata),
      ]
    )

    const quotaConsumption = await consumeQuota(uploadedBy, fileSizeBytes, fileHash)

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
      quotaConsumption,
    })
  } catch (err) {
    return res.status(err.status ?? 500).json({
      error: err.message ?? 'Upload failed',
    })
  } finally {
    await redis.del(uploadLockKey(uploadedBy, fileHash))
  }
})

app.listen(port, () => {
  console.log(`upload-service listening on port ${port}`)
})
