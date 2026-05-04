import { createClient } from 'redis'
import pg from 'pg'
import express from 'express'

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL,})
const app = express()
const PORT = Number(process.env.PORT || 3006)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const CHANNEL = process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode-complete'
const redis = createClient({ url: REDIS_URL })
const subscriber = createClient({ url: REDIS_URL })
const DLQ_NAME = "search-index-worker:dlq"
const LAST_SUCCESSFUL_JOB = "search-index-worker:last_successful_job"
const JOB_COUNT = "search-index-worker:jobs_completed"


redis.on('error', (err) => console.error('Redis error:', err.message))
subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message))

app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1')
    await redis.ping()

    const dlqDepth = await redis.lLen(DLQ_NAME)
    const lastJob = await redis.get(LAST_SUCCESSFUL_JOB)
    const totalJobs = await redis.get(JOB_COUNT)

    res.status(200).json({
      status: 'healthy',
      dlq_depth: dlqDepth || 0,
      last_successful_job: lastJob || 'no completed jobs',
      jobs_completed: parseInt(totalJobs || '0', 10),
      uptime: process.uptime()
    })
  } catch (err) {
    console.error('Health check failed:', err.message)
    res.status(500).json({ status: 'unhealthy', error: err.message })
  }
})

async function handleIndexing(payload) {
  const { 
    fileHash, 
    originalFilename, 
    contentType, 
    fileSizeBytes, 
    uploadedBy,
    status,
    duration,
    updatedAt 
  } = payload

  if (!fileHash) {
    throw new Error('Poison Pill: Payload is missing fileHash')
  }
  
  const query = `
    INSERT INTO video_search_index (
      file_hash, 
      original_filename, 
      content_type, 
      file_size_bytes, 
      uploaded_by, 
      status, 
      duration, 
      updated_at, 
      indexed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (file_hash) DO UPDATE 
    SET original_filename = EXCLUDED.original_filename, 
        content_type = EXCLUDED.content_type, 
        file_size_bytes = EXCLUDED.file_size_bytes,
        status = EXCLUDED.status,
        duration = EXCLUDED.duration,
        updated_at = EXCLUDED.updated_at,
        indexed_at = NOW();
  `
  const values = [
    fileHash, 
    originalFilename, 
    contentType, 
    fileSizeBytes, 
    uploadedBy, 
    status, 
    duration, 
    updatedAt
  ]

  await pool.query(query, values)
}

async function startWorker() {
  console.log('Starting Search Index Worker...')

  try {
    await redis.connect()
    await subscriber.connect()
    console.log(`Connected to Redis at ${REDIS_URL}`)
    await subscriber.subscribe(CHANNEL, async (message) => {
    console.log(`Receiving message from '${CHANNEL}':`, message)
      try {
        const payload = JSON.parse(message)
        await handleIndexing(payload)
        await redis.set(LAST_SUCCESSFUL_JOB, payload.fileHash)
        await redis.incr(JOB_COUNT)
        console.log(`Successfully processed: ${payload.fileHash}`)
      } catch (err) {
        console.error(`Failed to process, routing to DLQ: ${err.message}`)
        try {
            await redis.rPush(DLQ_NAME, JSON.stringify({
                originalMessage: message,
                error: err.message,
                failedAt: new Date().toISOString()
            }))
        } catch (dlqErr) {
            console.error(`DLQ push failed, message lost: ${dlqErr.message}`, message)
        }
      }
    })
    app.listen(PORT, () => {
      console.log(`Health check server listening on port ${PORT}`)
    })
    console.log(`Listening for events on channel: ${CHANNEL}`)
  } catch (err) {
    console.error('Failed to connect to Redis:', err)
    process.exit(1)
  }
}

async function shutdown(signal) {
    console.log(`Shutting down (${signal})`)
    await subscriber.unsubscribe()
    await subscriber.quit()
    await redis.quit()
    await pool.end()
    process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

startWorker()