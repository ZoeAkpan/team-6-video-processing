import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg
const app = express()

const PORT = Number(process.env.PORT || 3005)
const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const QUEUE_NAME = process.env.THUMBNAIL_QUEUE_NAME || 'thumbnail-jobs'
const DEAD_LETTER_QUEUE_NAME =
  process.env.THUMBNAIL_DEAD_LETTER_QUEUE_NAME || 'thumbnail-dead-letter'
const LAST_SUCCESS_KEY =
  process.env.THUMBNAIL_LAST_SUCCESS_KEY ||
  'thumbnail-worker:last-successfully-processed-job-at'
const THUMBNAIL_COMPLETE_CHANNEL =
  process.env.THUMBNAIL_COMPLETE_CHANNEL || 'thumbnail.complete'
const TRANSCODE_COMPLETE_CHANNELS = (
  process.env.TRANSCODE_COMPLETE_CHANNELS ||
  process.env.TRANSCODE_COMPLETE_CHANNEL ||
  'transcode-complete,transcode.complete'
)
  .split(',')
  .map((channel) => channel.trim())
  .filter(Boolean)

const PROCESSING_DELAY_MS = Number(process.env.THUMBNAIL_PROCESSING_DELAY_MS || 250)
const CATALOG_CACHE_KEY = process.env.CATALOG_CACHE_KEY || 'catalog:videos:available'
const MAX_DB_RETRY_ATTEMPTS = Number(process.env.THUMBNAIL_DB_RETRY_ATTEMPTS || 3)
const DB_RETRY_BASE_DELAY_MS = Number(
  process.env.THUMBNAIL_DB_RETRY_BASE_DELAY_MS || 500
)
const QUEUE_RETRY_DELAY_MS = Number(
  process.env.THUMBNAIL_QUEUE_RETRY_DELAY_MS || 1000
)

const pool = new Pool({
  connectionString: DATABASE_URL,
})
const redis = createClient({ url: REDIS_URL })
const subscriber = createClient({ url: REDIS_URL })
const workerRedis = createClient({ url: REDIS_URL })

let lastSuccessfullyProcessedJobAt = null
let inFlightJobId = null
let shuttingDown = false

class PoisonPillError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PoisonPillError'
  }
}

redis.on('error', (err) => {
  console.error('Thumbnail worker Redis error:', err.message)
})

subscriber.on('error', (err) => {
  console.error('Thumbnail worker subscriber Redis error:', err.message)
})

workerRedis.on('error', (err) => {
  console.error('Thumbnail worker queue Redis error:', err.message)
})

async function getLastSuccessfullyProcessedJobAt() {
  if (lastSuccessfullyProcessedJobAt) {
    return lastSuccessfullyProcessedJobAt
  }

  lastSuccessfullyProcessedJobAt = await redis.get(LAST_SUCCESS_KEY)
  return lastSuccessfullyProcessedJobAt
}

async function getQueueDepths() {
  const [queueDepth, deadLetterQueueDepth] = await Promise.all([
    redis.lLen(QUEUE_NAME),
    redis.lLen(DEAD_LETTER_QUEUE_NAME),
  ])

  return {
    queueDepth,
    deadLetterQueueDepth,
  }
}

async function getHealthSnapshot() {
  let db = 'ok'
  let redisStatus = 'ok'
  let queueDepth = null
  let deadLetterQueueDepth = null
  let lastSuccessfulJobAt = null

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    db = `error: ${err.message}`
  }

  try {
    const pong = await redis.ping()
    if (pong !== 'PONG' && pong !== 'pong') {
      throw new Error(`unexpected ping response: ${pong}`)
    }

    const depths = await getQueueDepths()
    queueDepth = depths.queueDepth
    deadLetterQueueDepth = depths.deadLetterQueueDepth
    lastSuccessfulJobAt = await getLastSuccessfullyProcessedJobAt()
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
      queueDepth,
      deadLetterQueueDepth,
      lastSuccessfullyProcessedJobAt: lastSuccessfulJobAt,
      inFlightJobId,
      subscribedChannels: TRANSCODE_COMPLETE_CHANNELS,
      timestamp: new Date().toISOString(),
    },
  }
}

function parseTranscodeComplete(raw) {
  let event

  if (typeof raw !== 'string' || !raw.trim()) {
    throw new PoisonPillError('event payload must be non-empty JSON')
  }

  try {
    event = JSON.parse(raw)
  } catch (err) {
    throw new PoisonPillError(`invalid json: ${err.message}`)
  }

  if (!event || typeof event !== 'object') {
    throw new PoisonPillError('event payload must be an object')
  }

  if (!event.jobId || !event.videoId) {
    throw new PoisonPillError('jobId and videoId are required')
  }

  if (typeof event.jobId !== 'string' || !event.jobId.trim()) {
    throw new PoisonPillError('jobId must be a non-empty string')
  }

  if (
    typeof event.videoId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.videoId
    )
  ) {
    throw new PoisonPillError('videoId must be a valid UUID')
  }

  return event
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientDatabaseError(err) {
  const transientCodes = new Set([
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '53300', // too_many_connections
    '53400', // configuration_limit_exceeded
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '58000', // system_error
    '58030', // io_error
  ])

  return (
    err?.code?.startsWith?.('08') ||
    transientCodes.has(err?.code) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(
      err?.code
    )
  )
}

async function ensureVideoExists(videoId) {
  const result = await pool.query('SELECT 1 FROM video WHERE id = $1', [videoId])

  if (result.rowCount === 0) {
    throw new PoisonPillError(`video does not exist: ${videoId}`)
  }
}

// figure out the video duration 
function getDurationSeconds(event) {
  const rawDuration = event.metadata?.duration ?? event.durationSeconds ?? 30
  const duration = Number.parseInt(rawDuration, 10)

  if (!Number.isFinite(duration) || duration <= 0) {
    return 30
  }

  return duration
}

// build fake thumbnail references (simulates extracting 3 thumbnails at different timestamps in the video)
function buildThumbnailReferences(event) {
  const duration = getDurationSeconds(event)
  const timestamps = [
    Math.max(1, Math.floor(duration * 0.1)),
    Math.max(1, Math.floor(duration * 0.5)),
    Math.max(1, Math.floor(duration * 0.9)),
  ]
  const uniqueTimestamps = [...new Set(timestamps)]

  return uniqueTimestamps.map((timestampSeconds) => ({
    videoId: event.videoId,
    timestampSeconds,
    thumbnailUrl: `/thumbnails/${event.videoId}/${timestampSeconds}.jpg`,
  }))
}

async function writeThumbnailReferences(thumbnailReferences) {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (const thumbnail of thumbnailReferences) {
      await client.query(
        `
          INSERT INTO thumbnail (video_id, thumbnail_url, timestamp_seconds)
          VALUES ($1, $2, $3)
          ON CONFLICT (video_id, timestamp_seconds)
          DO UPDATE SET thumbnail_url = EXCLUDED.thumbnail_url
        `,
        [thumbnail.videoId, thumbnail.thumbnailUrl, thumbnail.timestampSeconds]
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error('Thumbnail transaction rollback failed:', rollbackErr.message)
    }
    throw err
  } finally {
    client.release()
  }
}


async function processTranscodeComplete(event) {
  // Marks which job is currently being handled, so that it 
  // can be reported in the health check 
  inFlightJobId = event.jobId
  console.log(`thumbnail processing started job=${event.jobId} video=${event.videoId}`)

  // Simulate time taken to process the thumbnail job.
  if (PROCESSING_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS))
  }

  const thumbnailReferences = buildThumbnailReferences(event)
  console.log(
    `thumbnail extracting simulated refs job=${event.jobId} count=${thumbnailReferences.length}`
  )
  await ensureVideoExists(event.videoId)
  await writeThumbnailReferences(thumbnailReferences)
  console.log(
    `thumbnail wrote refs job=${event.jobId} video=${event.videoId} count=${thumbnailReferences.length}`
  )

  const processedAt = new Date().toISOString()
  lastSuccessfullyProcessedJobAt = processedAt
  await redis.set(LAST_SUCCESS_KEY, processedAt)
  // Clear the catalog cache 
  await redis.del(CATALOG_CACHE_KEY)

  // Publishes a new event saying thumbnails are complete, along with the thumbnail references 
  await redis.publish(
    THUMBNAIL_COMPLETE_CHANNEL,
    JSON.stringify({
      jobId: event.jobId,
      videoId: event.videoId,
      status: 'complete',
      thumbnails: thumbnailReferences,
      processedAt,
    })
  )
  console.log(`thumbnail published complete job=${event.jobId}`)

  console.log(
    `thumbnail job=${event.jobId} video=${event.videoId} refs=${thumbnailReferences.length} status=complete`
  )
}

async function moveToDeadLetter(raw, errorMessage, metadata = {}) {
  await redis.lPush(
    DEAD_LETTER_QUEUE_NAME,
    JSON.stringify({
      raw,
      error: errorMessage,
      ...metadata,
      failedAt: new Date().toISOString(),
    })
  )
}

async function safelyMoveToDeadLetter(raw, errorMessage, metadata = {}) {
  try {
    await moveToDeadLetter(raw, errorMessage, metadata)
    return true
  } catch (err) {
    console.error(
      `Thumbnail dead-letter write failed originalError="${errorMessage}" dlqError="${err.message}"`
    )
    return false
  }
}


async function handleTranscodeComplete(raw) {
  let event

  try {
    event = parseTranscodeComplete(raw)
    await redis.rPush(QUEUE_NAME, raw)
    const queueDepth = await redis.lLen(QUEUE_NAME)
    console.log(
      `thumbnail event received job=${event.jobId} video=${event.videoId} queued=true queueDepth=${queueDepth}`
    )
  } catch (err) {
    console.error('Thumbnail event enqueue failed:', err.message)
    await safelyMoveToDeadLetter(raw, err.message, {
      failureType: err instanceof PoisonPillError ? 'poison_pill' : 'enqueue_failure',
      attempts: 0,
      lastErrorCode: err.code,
    })
  }
}

async function processQueuedEvent(raw) {
  let attempts = 0

  try {
    const event = parseTranscodeComplete(raw)
    while (true) {
      try {
        attempts += 1
        await processTranscodeComplete(event)
        return
      } catch (err) {
        if (err instanceof PoisonPillError) {
          throw err
        }

        if (!isTransientDatabaseError(err) || attempts >= MAX_DB_RETRY_ATTEMPTS) {
          await safelyMoveToDeadLetter(raw, err.message, {
            failureType: isTransientDatabaseError(err)
              ? 'temporary_db_failure'
              : 'processing_failure',
            attempts,
            lastErrorCode: err.code,
          })
          return
        }

        const delayMs = DB_RETRY_BASE_DELAY_MS * attempts
        console.warn(
          `thumbnail temporary db failure job=${event.jobId} attempt=${attempts}/${MAX_DB_RETRY_ATTEMPTS} retryInMs=${delayMs}: ${err.message}`
        )
        await sleep(delayMs)
      }
    }
  } catch (err) {
    console.error('Thumbnail event failed:', err.message)
    await safelyMoveToDeadLetter(raw, err.message, {
      failureType: err instanceof PoisonPillError ? 'poison_pill' : 'processing_failure',
      attempts,
      lastErrorCode: err.code,
    })
  } finally {
    inFlightJobId = null
  }
}

async function workerLoop() {
  while (!shuttingDown) {
    let raw

    try {
      const result = await workerRedis.brPop(QUEUE_NAME, 1)
      raw = result?.element
      if (!raw) continue

      await processQueuedEvent(raw)
    } catch (err) {
      if (shuttingDown) break

      console.error('Thumbnail queue processing failed:', err.message)
      if (raw) {
        await safelyMoveToDeadLetter(raw, err.message, {
          failureType: 'queue_processing_failure',
          lastErrorCode: err.code,
        })
      }
      if (QUEUE_RETRY_DELAY_MS > 0) {
        await sleep(QUEUE_RETRY_DELAY_MS)
      }
    }
  }
}

app.get('/health', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot()
    return res.status(snapshot.healthy ? 200 : 503).json(snapshot.body)
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      error: err.message,
      timestamp: new Date().toISOString(),
    })
  }
})

app.use((_req, res) => {
  return res.status(404).json({
    error: 'not found',
  })
})

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down thumbnail-worker...`)
  shuttingDown = true

  try {
    if (subscriber.isOpen) {
      await subscriber.quit()
    }
  } catch (err) {
    console.error('Error while closing Redis subscriber:', err.message)
  }

  try {
    if (workerRedis.isOpen) {
      await workerRedis.quit()
    }
  } catch (err) {
    console.error('Error while closing queue Redis client:', err.message)
  }

  try {
    if (redis.isOpen) {
      await redis.quit()
    }
  } catch (err) {
    console.error('Error while closing Redis client:', err.message)
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
    await workerRedis.connect()
    await pool.query('SELECT 1')
    await getLastSuccessfullyProcessedJobAt()

    await subscriber.subscribe(TRANSCODE_COMPLETE_CHANNELS, handleTranscodeComplete)

    app.listen(PORT, () => {
      console.log(`thumbnail-worker listening on port ${PORT}`)
      console.log(
        `thumbnail-worker subscribed to ${TRANSCODE_COMPLETE_CHANNELS.join(', ')}`
      )
      console.log(`thumbnail-worker consuming queue ${QUEUE_NAME}`)
    })

    await workerLoop()
  } catch (err) {
    console.error('Failed to start thumbnail-worker:', err)
    process.exit(1)
  }
}

start()
