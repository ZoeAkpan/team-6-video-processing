import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const app = express()
const port = Number(process.env.PORT ?? 3000)
const quotaServiceUrl = process.env.QUOTA_SERVICE_URL ?? 'http://quota-service:3001'
const transcodeQueueName = process.env.TRANSCODE_QUEUE_NAME ?? 'transcode-jobs'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })

const startTime = Date.now()
const instanceId = process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? 'unknown'

app.use(express.json())
app.use((req, res, next) => {
  res.set('X-Service-Instance', instanceId)
  res.on('finish', () => {
    log('request_handled', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
    })
  })
  next()
})

pool.on('error', (err) => {
  console.error(
    JSON.stringify({
      event: 'db_pool_error',
      message: err.message,
      timestamp: new Date().toISOString(),
    })
  )
})

redis.on('error', (err) => {
  console.error(
    JSON.stringify({
      event: 'redis_error',
      message: err.message,
      timestamp: new Date().toISOString(),
    })
  )
})

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      event,
      instanceId,
      ...fields,
      timestamp: new Date().toISOString(),
    })
  )
}

function logError(event, err, fields = {}) {
  console.error(
    JSON.stringify({
      event,
      instanceId,
      message: err.message,
      stack: err.stack,
      ...fields,
      timestamp: new Date().toISOString(),
    })
  )
}

async function safeJson(response) {
  try {
    return await response.json()
  } catch (_) {
    return null
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })

  const payload = await safeJson(response)

  return {
    ok: response.ok,
    status: response.status,
    payload,
  }
}

async function checkQuota(userId, fileSizeBytes, fileHash) {
  return postJson(`${quotaServiceUrl}/quota/check`, {
    userId,
    fileSizeBytes,
    fileHash,
  })
}

async function consumeQuota(userId, fileSizeBytes, fileHash) {
  return postJson(`${quotaServiceUrl}/quota/consume`, {
    userId,
    fileSizeBytes,
    fileHash,
  })
}

async function releaseQuota(userId, fileHash, reason) {
  return postJson(`${quotaServiceUrl}/quota/release`, {
    userId,
    fileHash,
    reason,
  })
}

async function enqueueTranscodeJob(uploadPayload) {
  await redis.lPush(transcodeQueueName, JSON.stringify(uploadPayload))
}

async function getUploadByHash(fileHash) {
  const result = await pool.query(
    `
    SELECT
      file_hash AS "fileHash",
      original_filename AS "originalFilename",
      content_type AS "contentType",
      file_size_bytes AS "fileSizeBytes",
      uploaded_by AS "uploadedBy",
      duration,
      status,
      quota_consumed AS "quotaConsumed",
      error_message AS "errorMessage",
      transcode_enqueued_at AS "transcodeEnqueuedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM upload
    WHERE file_hash = $1
    `,
    [fileHash]
  )

  return result.rows[0] ?? null
}

async function insertUpload(uploadPayload) {
  const result = await pool.query(
    `
    INSERT INTO upload (
      file_hash,
      original_filename,
      content_type,
      file_size_bytes,
      uploaded_by,
      duration,
      status,
      quota_consumed,
      error_message
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'pending_quota', FALSE, NULL)
    RETURNING
      file_hash AS "fileHash",
      original_filename AS "originalFilename",
      content_type AS "contentType",
      file_size_bytes AS "fileSizeBytes",
      uploaded_by AS "uploadedBy",
      duration,
      status,
      quota_consumed AS "quotaConsumed",
      error_message AS "errorMessage",
      transcode_enqueued_at AS "transcodeEnqueuedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [
      uploadPayload.fileHash,
      uploadPayload.originalFilename,
      uploadPayload.contentType,
      uploadPayload.fileSizeBytes,
      uploadPayload.uploadedBy,
      uploadPayload.duration,
    ]
  )

  return result.rows[0]
}

async function updateUploadState(
  fileHash,
  { status, quotaConsumed, errorMessage, markEnqueued = false }
) {
  await pool.query(
    `
    UPDATE upload
    SET
      status = $2,
      quota_consumed = $3,
      error_message = $4,
      transcode_enqueued_at = CASE
        WHEN $5 THEN NOW()
        ELSE transcode_enqueued_at
      END
    WHERE file_hash = $1
    `,
    [fileHash, status, quotaConsumed, errorMessage, markEnqueued]
  )
}

app.get('/health', async (_req, res) => {
  const checks = {}
  let healthy = true

  const dbStart = Date.now()
  try {
    await pool.query('SELECT 1')
    checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart }
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  const redisStart = Date.now()
  try {
    const pong = await redis.ping()
    if (pong !== 'PONG') throw new Error(`unexpected response: ${pong}`)
    checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart }
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  try {
    const response = await fetch(`${quotaServiceUrl}/health`)
    checks.quotaService = {
      status: response.ok ? 'healthy' : 'unhealthy',
      http_status: response.status,
    }
    if (!response.ok) {
      healthy = false
    }
  } catch (err) {
    checks.quotaService = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  try {
    const depth = await redis.lLen(transcodeQueueName)
    checks.transcodeQueue = {
      status: 'healthy',
      name: transcodeQueueName,
      depth,
    }
  } catch (err) {
    checks.transcodeQueue = { status: 'unhealthy', error: err.message }
    healthy = false
  }

  const body = {
    status: healthy ? 'healthy' : 'unhealthy',
    service: process.env.SERVICE_NAME ?? 'upload-service',
    instanceId,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  }

  res.status(healthy ? 200 : 503).json(body)
})

app.post('/upload/seed', async (req, res) => {
  const count = 100
  const contentTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm', 'video/mkv']
  const statuses = { success: 0, duplicate: 0, failed: 0 }
  const results = []

  for (let i = 0; i < count; i++) {
    const fileHash = `seed-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 10)}`
    const payload = {
      originalFilename: `seed-video-${i + 1}.mp4`,
      contentType: contentTypes[i % contentTypes.length],
      fileSizeBytes: Math.floor(Math.random() * 100) + 1,
      uploadedBy: `seed-user-${(i % 10) + 1}`,
      fileHash,
      duration: Math.round((Math.random() * 30)) + 1,
    }

    try {
      const response = await postJson(`http://localhost:${port}/upload`, payload)

      if (response.status === 201) {
        statuses.success++
        results.push({ index: i + 1, fileHash, status: response.status, ok: response.ok })
      } else if (response.status === 200) {
        statuses.duplicate++
        results.push({ index: i + 1, fileHash, status: response.status, ok: response.ok })
      } else { 
        statuses.failed++
        log("seed_upload_failed", { error: response.payload.error, ...payload })
        results.push({ index: i + 1, fileHash, status: response.status, ok: response.ok, error: response.payload.error })
      }

      
    } catch (err) {
      statuses.failed++
      results.push({ index: i + 1, fileHash, status: null, ok: false, error: err.message })
    }
  }

  log('seed_completed', { count, ...statuses })

  return res.status(200).json({
    message: `Seeded ${count} upload requests`,
    summary: { total: count, ...statuses },
    results,
  })
})

app.get('/upload/:fileHash', async (req, res) => {
  try {
    const upload = await getUploadByHash(req.params.fileHash)

    if (!upload) {
      return res.status(404).json({
        error: 'upload_not_found',
      })
    }

    return res.status(200).json(upload)
  } catch (err) {
    logError('get_upload_error', err, { fileHash: req.params.fileHash })
    return res.status(500).json({
      error: 'internal_server_error',
    })
  }
})

app.post('/upload', async (req, res) => {
  const expectedFields = [
    'originalFilename',
    'contentType',
    'fileSizeBytes',
    'uploadedBy',
    'fileHash',
    'duration',
  ]

  if (!expectedFields.every((field) => field in req.body)) {
    return res.status(400).json({
      error:
        'missing fields from request body: originalFilename, contentType, fileSizeBytes, uploadedBy, fileHash, duration',
    })
  }

  const {
    originalFilename,
    contentType,
    fileSizeBytes,
    uploadedBy,
    fileHash,
    duration,
  } = req.body

  const uploadPayload = {
    originalFilename,
    contentType,
    fileSizeBytes,
    uploadedBy,
    fileHash,
    duration,
  }

  if (typeof originalFilename !== 'string' || !originalFilename.trim()) {
    return res.status(400).json({
      error: 'originalFilename must be a non-empty string',
    })
  }

  if (typeof contentType !== 'string' || !contentType.trim()) {
    return res.status(400).json({
      error: 'contentType must be a non-empty string',
    })
  }

  if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
    return res.status(400).json({
      error: 'fileSizeBytes must be a positive integer',
    })
  }

  if (typeof uploadedBy !== 'string' || !uploadedBy.trim()) {
    return res.status(400).json({
      error: 'uploadedBy must be a non-empty string',
    })
  }

  if (typeof duration !== 'number' || Number.isNaN(duration) || duration <= 0) {
    return res.status(400).json({
      error: 'duration must be a positive number',
    })
  }

  if (typeof fileHash !== 'string' || !fileHash.trim()) {
    return res.status(400).json({
      error: 'fileHash is required and must be a non-empty string',
    })
  }

  try {
    const existing = await getUploadByHash(fileHash)

    if (existing) {
      return res.status(200).json({
        message: 'An upload with this file hash already exists',
        duplicate: true,
        fileHash,
        upload: existing,
      })
    }

    const quota = await checkQuota(uploadedBy, fileSizeBytes, fileHash)

    if (!quota.ok) {
      return res.status(quota.status >= 500 ? 503 : quota.status).json({
        error: 'quota check failed',
        details: quota.payload,
      })
    }

    if (!quota.payload.allowed) {
      return res.status(403).json({
        error: 'Upload blocked by quota service',
        quota: quota.payload,
        upload: uploadPayload,
      })
    }

    try {
      await insertUpload(uploadPayload)
    } catch (err) {
      if (err.code === '23505') {
        const duplicate = await getUploadByHash(fileHash)
        return res.status(200).json({
          message: 'An upload with this file hash already exists',
          duplicate: true,
          fileHash,
          upload: duplicate,
        })
      }
      throw err
    }

    const quotaConsumption = await consumeQuota(uploadedBy, fileSizeBytes, fileHash)

    if (!quotaConsumption.ok) {
      await updateUploadState(fileHash, {
        status: 'quota_failed',
        quotaConsumed: false,
        errorMessage: `quota consume failed: ${
          quotaConsumption.payload?.reason ??
          quotaConsumption.payload?.error ??
          quotaConsumption.status
        }`,
      })

      return res.status(quotaConsumption.status === 409 ? 403 : 503).json({
        error: 'quota consume failed',
        details: quotaConsumption.payload,
        upload: await getUploadByHash(fileHash),
      })
    }

    try {
      await enqueueTranscodeJob(uploadPayload)
    } catch (queueErr) {
      let quotaRelease

      try {
        quotaRelease = await releaseQuota(
          uploadedBy,
          fileHash,
          'queue_enqueue_failed'
        )
      } catch (releaseErr) {
        quotaRelease = {
          ok: false,
          status: 503,
          payload: { error: releaseErr.message },
        }
      }

      const quotaReleased =
        quotaRelease.ok &&
        (quotaRelease.payload?.released === true ||
          quotaRelease.payload?.idempotentReplay === true)

      await updateUploadState(fileHash, {
        status: quotaReleased
          ? 'queue_failed_refunded'
          : 'queue_failed_refund_pending',
        quotaConsumed: !quotaReleased,
        errorMessage: quotaReleased
          ? `queue push failed: ${queueErr.message}`
          : `queue push failed and quota release failed: ${queueErr.message}`,
      })

      return res.status(503).json({
        error: 'failed to enqueue transcode job',
        quotaReleased,
        releaseDetails: quotaRelease.payload,
        upload: await getUploadByHash(fileHash),
      })
    }

    await updateUploadState(fileHash, {
      status: 'queued',
      quotaConsumed: true,
      errorMessage: null,
      markEnqueued: true,
    })

    try {
      await redis.set(`upload:${fileHash}`, '1')
    } catch (cacheErr) {
      logError('upload_cache_set_error', cacheErr, { fileHash })
    }

    return res.status(201).json({
      message: 'Upload accepted',
      duplicate: false,
      upload: await getUploadByHash(fileHash),
      quota: quota.payload,
      quotaConsumption: quotaConsumption.payload,
    })
  } catch (err) {
    logError('upload_error', err, { fileHash, uploadedBy })

    return res.status(500).json({
      error: 'Upload failed',
    })
  }
})

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'invalid_json',
    })
  }

  logError('unhandled_error', err)

  return res.status(500).json({
    error: 'internal_server_error',
  })
})

async function start() {
  try {
    await pool.query('SELECT 1')
    await redis.connect()

    app.listen(port, () => {
      log('upload_service_started', {
        port,
        queueName: transcodeQueueName,
      })
    })
  } catch (err) {
    logError('startup_error', err)
    process.exit(1)
  }
}

async function shutdown(signal) {
  log('shutdown_started', { signal })

  try {
    if (redis.isOpen) {
      await redis.quit()
    }
  } catch (err) {
    logError('redis_shutdown_error', err)
  }

  try {
    await pool.end()
  } catch (err) {
    logError('db_shutdown_error', err)
  }

  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
