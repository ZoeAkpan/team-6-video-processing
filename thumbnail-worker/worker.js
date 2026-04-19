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

const pool = new Pool({
  connectionString: DATABASE_URL,
})
const redis = createClient({ url: REDIS_URL })
const subscriber = createClient({ url: REDIS_URL })
const workerRedis = createClient({ url: REDIS_URL })

let lastSuccessfullyProcessedJobAt = null
let inFlightJobId = null
let shuttingDown = false

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

  try {
    event = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid json: ${err.message}`)
  }

  if (!event || typeof event !== 'object') {
    throw new Error('event payload must be an object')
  }

  if (!event.jobId || !event.videoId) {
    throw new Error('jobId and videoId are required')
  }

  return event
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
    await client.query('ROLLBACK')
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

async function moveToDeadLetter(raw, errorMessage) {
  await redis.lPush(
    DEAD_LETTER_QUEUE_NAME,
    JSON.stringify({
      raw,
      error: errorMessage,
      failedAt: new Date().toISOString(),
    })
  )
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
    await moveToDeadLetter(raw, err.message)
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

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down thumbnail-worker...`)

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
    await pool.query('SELECT 1')
    await getLastSuccessfullyProcessedJobAt()

    await subscriber.subscribe(TRANSCODE_COMPLETE_CHANNELS, handleTranscodeComplete)

    app.listen(PORT, () => {
      console.log(`thumbnail-worker listening on port ${PORT}`)
      console.log(
        `thumbnail-worker subscribed to ${TRANSCODE_COMPLETE_CHANNELS.join(', ')}`
      )
    })
  } catch (err) {
    console.error('Failed to start thumbnail-worker:', err)
    process.exit(1)
  }
}

start()
