import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT || 3001)
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://quota:quota@quota-db:5432/quota'
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const DEFAULT_UPLOAD_LIMIT_COUNT = Number(
  process.env.DEFAULT_UPLOAD_LIMIT_COUNT || 10
)
const DEFAULT_STORAGE_LIMIT_BYTES = Number(
  process.env.DEFAULT_STORAGE_LIMIT_BYTES || 1073741824
)
const SERVICE_INSTANCE =
  process.env.INSTANCE_ID || process.env.HOSTNAME || 'quota-service-local'

const pool = new Pool({
  connectionString: DATABASE_URL,
})

const redis = createClient({
  url: REDIS_URL,
})

redis.on('error', (err) => {
  console.error(
    JSON.stringify({
      event: 'redis_error',
      service: 'quota-service',
      serviceInstance: SERVICE_INSTANCE,
      message: err.message,
      timestamp: new Date().toISOString(),
    })
  )
})

pool.on('error', (err) => {
  console.error(
    JSON.stringify({
      event: 'db_pool_error',
      service: 'quota-service',
      serviceInstance: SERVICE_INSTANCE,
      message: err.message,
      timestamp: new Date().toISOString(),
    })
  )
})

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      event,
      service: 'quota-service',
      serviceInstance: SERVICE_INSTANCE,
      ...fields,
      timestamp: new Date().toISOString(),
    })
  )
}

function logError(event, err, fields = {}) {
  console.error(
    JSON.stringify({
      event,
      service: 'quota-service',
      serviceInstance: SERVICE_INSTANCE,
      message: err.message,
      stack: err.stack,
      ...fields,
      timestamp: new Date().toISOString(),
    })
  )
}

function withServiceInstance(payload) {
  return {
    serviceInstance: SERVICE_INSTANCE,
    ...payload,
  }
}

function validateQuotaCheckBody(body) {
  const errors = []

  if (!body || typeof body !== 'object') {
    errors.push('request body must be a JSON object')
    return errors
  }

  if (!body.userId || typeof body.userId !== 'string' || !body.userId.trim()) {
    errors.push('userId is required and must be a non-empty string')
  }

  if (!Number.isInteger(body.fileSizeBytes) || body.fileSizeBytes <= 0) {
    errors.push('fileSizeBytes is required and must be a positive integer')
  }

  if (
    body.fileHash !== undefined &&
    (typeof body.fileHash !== 'string' || !body.fileHash.trim())
  ) {
    errors.push('fileHash must be a non-empty string when provided')
  }

  return errors
}

function validateQuotaConsumeBody(body) {
  const errors = validateQuotaCheckBody(body)

  if (!body?.fileHash || typeof body.fileHash !== 'string' || !body.fileHash.trim()) {
    errors.push('fileHash is required and must be a non-empty string')
  }

  return [...new Set(errors)]
}

function validateQuotaReleaseBody(body) {
  const errors = []

  if (!body || typeof body !== 'object') {
    errors.push('request body must be a JSON object')
    return errors
  }

  if (!body.userId || typeof body.userId !== 'string' || !body.userId.trim()) {
    errors.push('userId is required and must be a non-empty string')
  }

  if (!body.fileHash || typeof body.fileHash !== 'string' || !body.fileHash.trim()) {
    errors.push('fileHash is required and must be a non-empty string')
  }

  if (
    body.reason !== undefined &&
    (typeof body.reason !== 'string' || !body.reason.trim())
  ) {
    errors.push('reason must be a non-empty string when provided')
  }

  return errors
}

async function ensureQuotaRow(db, userId) {
  await db.query(
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
}

async function getQuotaRow(db, userId, { forUpdate = false } = {}) {
  const result = await db.query(
    `
    SELECT
      user_id,
      upload_count,
      upload_limit_count,
      storage_used_bytes,
      storage_limit_bytes
    FROM quotas
    WHERE user_id = $1
    ${forUpdate ? 'FOR UPDATE' : ''}
    `,
    [userId]
  )

  return result.rows[0]
}

function serializeQuota(row) {
  const uploadCount = Number(row.upload_count)
  const uploadLimitCount = Number(row.upload_limit_count)
  const storageUsedBytes = Number(row.storage_used_bytes)
  const storageLimitBytes = Number(row.storage_limit_bytes)

  return {
    userId: row.user_id,
    uploadCount,
    uploadLimitCount,
    remainingUploadSlots: Math.max(0, uploadLimitCount - uploadCount),
    storageUsedBytes,
    storageLimitBytes,
    remainingBytes: Math.max(0, storageLimitBytes - storageUsedBytes),
  }
}

function buildQuotaDecision(row, fileSizeBytes) {
  const state = serializeQuota(row)

  const allowedByCount = state.uploadCount + 1 <= state.uploadLimitCount
  const allowedByStorage =
    state.storageUsedBytes + fileSizeBytes <= state.storageLimitBytes

  let reason = 'ok'
  if (!allowedByCount) {
    reason = 'upload_limit_exceeded'
  } else if (!allowedByStorage) {
    reason = 'storage_limit_exceeded'
  }

  return {
    allowed: allowedByCount && allowedByStorage,
    reason,
    state,
  }
}

async function rollbackQuietly(client) {
  try {
    await client.query('ROLLBACK')
  } catch (_) {}
}

app.get('/health', async (_req, res) => {
  let db = 'error'
  let redisStatus = 'error'

  try {
    await pool.query('SELECT 1')
    db = 'ok'
  } catch (err) {
    logError('db_health_error', err)
  }

  try {
    const pong = await redis.ping()
    redisStatus = pong === 'PONG' ? 'ok' : 'error'
  } catch (err) {
    logError('redis_health_error', err)
  }

  const healthy = db === 'ok' && redisStatus === 'ok'

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: 'quota-service',
    serviceInstance: SERVICE_INSTANCE,
    db,
    redis: redisStatus,
  })
})

app.get('/quota/:userId', async (req, res) => {
  const { userId } = req.params

  if (!userId || !userId.trim()) {
    return res.status(400).json(withServiceInstance({
      error: 'invalid_request',
      details: ['userId is required'],
    }))
  }

  try {
    await ensureQuotaRow(pool, userId)
    const quota = await getQuotaRow(pool, userId)

    const consumptionCounts = await pool.query(
      `
      SELECT
        COUNT(*) AS total_consumptions,
        COUNT(*) FILTER (WHERE released_at IS NULL) AS active_consumptions,
        COUNT(*) FILTER (WHERE released_at IS NOT NULL) AS released_consumptions
      FROM quota_consumptions
      WHERE user_id = $1
      `,
      [userId]
    )

    const counts = consumptionCounts.rows[0]

    return res.status(200).json(withServiceInstance({
      ...serializeQuota(quota),
      totalConsumptions: Number(counts.total_consumptions),
      activeConsumptions: Number(counts.active_consumptions),
      releasedConsumptions: Number(counts.released_consumptions),
    }))
  } catch (err) {
    logError('quota_get_error', err, { userId })
    return res.status(500).json(withServiceInstance({
      error: 'internal_server_error',
    }))
  }
})

app.post('/quota/check', async (req, res) => {
  try {
    const errors = validateQuotaCheckBody(req.body)

    if (errors.length > 0) {
      log('quota_check_rejected', {
        reason: 'invalid_request',
        details: errors,
        requestBody: req.body,
      })

      return res.status(400).json(withServiceInstance({
        error: 'invalid_request',
        details: errors,
      }))
    }

    const { userId, fileSizeBytes, fileHash } = req.body

    await ensureQuotaRow(pool, userId)
    const row = await getQuotaRow(pool, userId)

    const decision = buildQuotaDecision(row, fileSizeBytes)

    log('quota_checked', {
      userId,
      fileHash: fileHash ?? null,
      requestedFileSizeBytes: fileSizeBytes,
      allowed: decision.allowed,
      reason: decision.reason,
      ...decision.state,
    })

    return res.status(200).json(withServiceInstance({
      allowed: decision.allowed,
      reason: decision.reason,
      requestedFileSizeBytes: fileSizeBytes,
      ...decision.state,
    }))
  } catch (err) {
    logError('quota_check_error', err)
    return res.status(500).json(withServiceInstance({
      error: 'internal_server_error',
    }))
  }
})

app.post('/quota/consume', async (req, res) => {
  const client = await pool.connect()

  try {
    const errors = validateQuotaConsumeBody(req.body)

    if (errors.length > 0) {
      log('quota_consume_rejected', {
        reason: 'invalid_request',
        details: errors,
        requestBody: req.body,
      })

      return res.status(400).json(withServiceInstance({
        error: 'invalid_request',
        details: errors,
      }))
    }

    const { userId, fileSizeBytes, fileHash } = req.body

    await client.query('BEGIN')

    await ensureQuotaRow(client, userId)

    const quotaRow = await getQuotaRow(client, userId, { forUpdate: true })

    const existingConsumptionResult = await client.query(
      `
      SELECT
        user_id,
        file_hash,
        file_size_bytes,
        released_at,
        released_reason
      FROM quota_consumptions
      WHERE user_id = $1 AND file_hash = $2
      FOR UPDATE
      `,
      [userId, fileHash]
    )

    const existingConsumption = existingConsumptionResult.rows[0]

    if (existingConsumption && existingConsumption.released_at === null) {
      await client.query('COMMIT')

      log('quota_consumed', {
        userId,
        fileHash,
        fileSizeBytes,
        consumed: false,
        idempotentReplay: true,
        reason: 'already_consumed',
        ...serializeQuota(quotaRow),
      })

      return res.status(200).json(withServiceInstance({
        consumed: false,
        idempotentReplay: true,
        reason: 'already_consumed',
        ...serializeQuota(quotaRow),
      }))
    }

    const decision = buildQuotaDecision(quotaRow, fileSizeBytes)

    if (!decision.allowed) {
      await client.query('ROLLBACK')

      log('quota_consume_denied', {
        userId,
        fileHash,
        fileSizeBytes,
        reason: decision.reason,
        ...decision.state,
      })

      return res.status(409).json(withServiceInstance({
        error: 'quota_exceeded',
        reason: decision.reason,
        requestedFileSizeBytes: fileSizeBytes,
        ...decision.state,
      }))
    }

    if (existingConsumption && existingConsumption.released_at !== null) {
      await client.query(
        `
        UPDATE quota_consumptions
        SET
          file_size_bytes = $3,
          released_at = NULL,
          released_reason = NULL
        WHERE user_id = $1 AND file_hash = $2
        `,
        [userId, fileHash, fileSizeBytes]
      )
    } else {
      await client.query(
        `
        INSERT INTO quota_consumptions (user_id, file_hash, file_size_bytes)
        VALUES ($1, $2, $3)
        `,
        [userId, fileHash, fileSizeBytes]
      )
    }

    await client.query(
      `
      UPDATE quotas
      SET
        upload_count = upload_count + 1,
        storage_used_bytes = storage_used_bytes + $2
      WHERE user_id = $1
      `,
      [userId, fileSizeBytes]
    )

    const updatedQuota = await getQuotaRow(client, userId)
    await client.query('COMMIT')

    log('quota_consumed', {
      userId,
      fileHash,
      fileSizeBytes,
      consumed: true,
      idempotentReplay: false,
      reason: 'consumed',
      ...serializeQuota(updatedQuota),
    })

    return res.status(200).json(withServiceInstance({
      consumed: true,
      idempotentReplay: false,
      reason: 'consumed',
      ...serializeQuota(updatedQuota),
    }))
  } catch (err) {
    await rollbackQuietly(client)
    logError('quota_consume_error', err)
    return res.status(500).json(withServiceInstance({
      error: 'internal_server_error',
    }))
  } finally {
    client.release()
  }
})

app.post('/quota/release', async (req, res) => {
  const client = await pool.connect()

  try {
    const errors = validateQuotaReleaseBody(req.body)

    if (errors.length > 0) {
      log('quota_release_rejected', {
        reason: 'invalid_request',
        details: errors,
        requestBody: req.body,
      })

      return res.status(400).json(withServiceInstance({
        error: 'invalid_request',
        details: errors,
      }))
    }

    const { userId, fileHash } = req.body
    const reason = req.body.reason?.trim() || 'released'

    await client.query('BEGIN')

    await ensureQuotaRow(client, userId)
    await getQuotaRow(client, userId, { forUpdate: true })

    const existingConsumptionResult = await client.query(
      `
      SELECT
        user_id,
        file_hash,
        file_size_bytes,
        released_at
      FROM quota_consumptions
      WHERE user_id = $1 AND file_hash = $2
      FOR UPDATE
      `,
      [userId, fileHash]
    )

    const existingConsumption = existingConsumptionResult.rows[0]

    if (!existingConsumption) {
      const quotaRow = await getQuotaRow(client, userId)
      await client.query('COMMIT')

      log('quota_released', {
        userId,
        fileHash,
        released: false,
        idempotentReplay: true,
        reason: 'nothing_to_release',
        ...serializeQuota(quotaRow),
      })

      return res.status(200).json(withServiceInstance({
        released: false,
        idempotentReplay: true,
        reason: 'nothing_to_release',
        ...serializeQuota(quotaRow),
      }))
    }

    if (existingConsumption.released_at !== null) {
      const quotaRow = await getQuotaRow(client, userId)
      await client.query('COMMIT')

      log('quota_released', {
        userId,
        fileHash,
        released: false,
        idempotentReplay: true,
        reason: 'already_released',
        ...serializeQuota(quotaRow),
      })

      return res.status(200).json(withServiceInstance({
        released: false,
        idempotentReplay: true,
        reason: 'already_released',
        ...serializeQuota(quotaRow),
      }))
    }

    await client.query(
      `
      UPDATE quota_consumptions
      SET
        released_at = NOW(),
        released_reason = $3
      WHERE user_id = $1 AND file_hash = $2
      `,
      [userId, fileHash, reason]
    )

    await client.query(
      `
      UPDATE quotas
      SET
        upload_count = GREATEST(upload_count - 1, 0),
        storage_used_bytes = GREATEST(storage_used_bytes - $2, 0)
      WHERE user_id = $1
      `,
      [userId, Number(existingConsumption.file_size_bytes)]
    )

    const updatedQuota = await getQuotaRow(client, userId)
    await client.query('COMMIT')

    log('quota_released', {
      userId,
      fileHash,
      released: true,
      idempotentReplay: false,
      reason,
      ...serializeQuota(updatedQuota),
    })

    return res.status(200).json(withServiceInstance({
      released: true,
      idempotentReplay: false,
      reason,
      ...serializeQuota(updatedQuota),
    }))
  } catch (err) {
    await rollbackQuietly(client)
    logError('quota_release_error', err)
    return res.status(500).json(withServiceInstance({
      error: 'internal_server_error',
    }))
  } finally {
    client.release()
  }
})

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json(withServiceInstance({
      error: 'invalid_json',
    }))
  }

  logError('unhandled_error', err)

  return res.status(500).json(withServiceInstance({
    error: 'internal_server_error',
  }))
})

async function start() {
  try {
    await pool.query('SELECT 1')
    await redis.connect()

    app.listen(PORT, () => {
      log('quota_service_started', {
        port: PORT,
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
