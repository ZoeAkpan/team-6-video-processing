import express from 'express'
import { createClient } from 'redis'

const app = express()

const PORT = Number(process.env.PORT || 3005)
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const QUEUE_NAME = process.env.THUMBNAIL_QUEUE_NAME || 'thumbnail-jobs'
const DEAD_LETTER_QUEUE_NAME =
  process.env.THUMBNAIL_DEAD_LETTER_QUEUE_NAME || 'thumbnail-dead-letter'
const LAST_SUCCESS_KEY =
  process.env.THUMBNAIL_LAST_SUCCESS_KEY ||
  'thumbnail-worker:last-successfully-processed-job-at'
const THUMBNAIL_COMPLETE_CHANNEL =
  process.env.THUMBNAIL_COMPLETE_CHANNEL || 'thumbnail.complete'
const PROCESSING_DELAY_MS = Number(process.env.THUMBNAIL_PROCESSING_DELAY_MS || 250)

const redis = createClient({ url: REDIS_URL })
const workerRedis = createClient({ url: REDIS_URL })

let lastSuccessfullyProcessedJobAt = null
let inFlightJobId = null
let shuttingDown = false

redis.on('error', (err) => {
  console.error('Thumbnail worker Redis error:', err.message)
})

workerRedis.on('error', (err) => {
  console.error('Thumbnail worker blocking Redis error:', err.message)
})

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

async function getLastSuccessfullyProcessedJobAt() {
  if (lastSuccessfullyProcessedJobAt) {
    return lastSuccessfullyProcessedJobAt
  }

  lastSuccessfullyProcessedJobAt = await redis.get(LAST_SUCCESS_KEY)
  return lastSuccessfullyProcessedJobAt
}

async function getHealthSnapshot() {
  let redisStatus = 'ok'
  let queueDepth = null
  let deadLetterQueueDepth = null
  let lastSuccessfulJobAt = null

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

  const healthy = redisStatus === 'ok'

  return {
    healthy,
    body: {
      status: healthy ? 'healthy' : 'unhealthy',
      redis: redisStatus,
      queueDepth,
      deadLetterQueueDepth,
      lastSuccessfullyProcessedJobAt: lastSuccessfulJobAt,
      inFlightJobId,
      timestamp: new Date().toISOString(),
    },
  }
}

function parseJob(raw) {
  let job

  try {
    job = JSON.parse(raw)
  } catch (err) {
    throw new Error(`invalid json: ${err.message}`)
  }

  if (!job || typeof job !== 'object') {
    throw new Error('job payload must be an object')
  }

  if (!job.jobId || !job.videoId) {
    throw new Error('jobId and videoId are required')
  }

  return job
}

async function processJob(job) {
  inFlightJobId = job.jobId

  if (PROCESSING_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS))
  }

  const processedAt = new Date().toISOString()
  lastSuccessfullyProcessedJobAt = processedAt
  await redis.set(LAST_SUCCESS_KEY, processedAt)

  await redis.publish(
    THUMBNAIL_COMPLETE_CHANNEL,
    JSON.stringify({
      jobId: job.jobId,
      videoId: job.videoId,
      status: 'complete',
      thumbnailUrl: job.thumbnailUrl || `/thumbnails/${job.videoId}.jpg`,
      processedAt,
    })
  )

  console.log(`thumbnail job=${job.jobId} video=${job.videoId} status=complete`)
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

async function workerLoop() {
  while (!shuttingDown) {
    let raw

    try {
      const result = await workerRedis.brPop(QUEUE_NAME, 1)
      raw = result?.element
      if (!raw) continue

      const job = parseJob(raw)
      await processJob(job)
    } catch (err) {
      console.error('Thumbnail job failed:', err.message)
      if (raw) {
        await moveToDeadLetter(raw, err.message)
      }
    } finally {
      inFlightJobId = null
    }
  }
}