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

async function enqueueTranscodeJob(upload, metadata) {
  const now = new Date().toISOString()

  await redis.hSet(`job:${upload.id}`, {
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  })
  await redis.expire(`job:${upload.id}`, 24 * 60 * 60)

  await redis.lPush('transcode-jobs', JSON.stringify({
    jobId: upload.id,
    videoId: upload.id,
    originalFilename: upload.original_filename,
    contentType: upload.content_type,
    fileSizeBytes: Number(upload.file_size_bytes),
    uploadedBy: upload.uploaded_by,
    metadata,
  }))
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
    fileHash,
    metadata = {},
  } = req.body ?? {}

  const fileHash = getFileHash(req.body)
  const normalizedMetadata = { ...metadata, fileHash, file_hash: fileHash }

  if (!originalFilename || !contentType || !uploadedBy || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0 || !fileHash) {
    return res.status(400).json({
      error: 'originalFilename, contentType, uploadedBy, fileHash, and positive numeric fileSizeBytes are required',
    })
  }

  if (typeof fileHash !== 'string' || !fileHash.trim()) {
    return res.status(400).json({
      error: 'fileHash is required and must be a non-empty string',
    })
  }

  const uploadFileHash = normalizeHash(fileHash)

  try {
    const existingUpload = await pool.query(
      'SELECT * FROM upload WHERE file_hash = $1',
      [uploadFileHash]
    )

    if (existingUpload.rowCount > 0) {
      return res.status(200).json({
        message: 'Upload already exists',
        upload: existingUpload.rows[0],
        idempotent: true,
      })
    }

    const quota = await checkQuota(uploadedBy, fileSizeBytes, uploadFileHash)

    if (!quota.allowed) {
      return res.status(403).json({
        error: 'Upload blocked by quota service',
        quota,
      })
    }

    const storageKey = `uploads/${Date.now()}-${originalFilename}`
    const uploadId = crypto.randomUUID()
    const { rows } = await pool.query(
      `INSERT INTO upload (
        id,
        original_filename,
        storage_key,
        file_hash,
        content_type,
        file_size_bytes,
        uploaded_by,
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (file_hash) DO NOTHING
      RETURNING *`,
      [
        uploadId,
        originalFilename,
        storageKey,
        uploadFileHash,
        contentType,
        fileSizeBytes,
        uploadedBy,
        'pending',
        JSON.stringify(normalizedMetadata),
      ]
    )

    if (rows.length === 0) {
      const duplicate = await pool.query(
        'SELECT * FROM upload WHERE file_hash = $1',
        [uploadFileHash]
      )

      return res.status(200).json({
        message: 'Upload already exists',
        upload: duplicate.rows[0],
        idempotent: true,
      })
    }

    await enqueueTranscodeJob(rows[0], metadata)

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
  }
})

app.listen(port, () => {
  console.log(`upload-service listening on port ${port}`)
})
