import { createClient } from 'redis'
import pg from 'pg'
import express from 'express'

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL,})
const app = express()
const PORT = Number(process.env.PORT || 3006)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const TRANSCODE_CHANNEL = process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode-complete'
const VIEW_STARTED_CHANNEL = process.env.VIEW_STARTED_CHANNEL || 'view-started'

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
      indexed_at,
      views
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 0)
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
async function handleViewStarted(payload) {
  const fileHash = payload.videoId || payload.fileHash; 

  if (!fileHash) {
    throw new Error('Poison Pill: Payload is missing videoId/fileHash');
  }

  const query = `
    UPDATE video_search_index
    SET views = COALESCE(views, 0) + 1,
        updated_at = NOW()
    WHERE file_hash = $1;
  `;
  
  await pool.query(query, [fileHash]);
}

async function routeToDLQ(message, err) {
  const dlqPayload = {
    originalMessage: message,
    error: err.message,
    failedAt: new Date().toISOString()
  }
  await redis.rPush(DLQ_NAME, JSON.stringify(dlqPayload))
}

async function startWorker() {
  console.log('Starting Search Index Worker...')

  try {
    await redis.connect()
    await subscriber.connect()
    console.log(`Connected to Redis at ${REDIS_URL}`)
    await subscriber.subscribe(TRANSCODE_CHANNEL, async (message) => {
      console.log(`Receiving message from '${TRANSCODE_CHANNEL}':`, message)
      try {
        const payload = JSON.parse(message)
        await handleIndexing(payload)
        await redis.set(LAST_SUCCESSFUL_JOB, `index:${payload.fileHash}`)
        await redis.incr(JOB_COUNT)
        console.log(`Successfully indexed: ${payload.fileHash}`)
      } catch (err) {
        console.error(`Failed to process index, routing to DLQ: ${err.message}`)
        await routeToDLQ(message, err)
      }
    })
    await subscriber.subscribe(VIEW_STARTED_CHANNEL, async (message) => {
      console.log(`Receiving message from '${VIEW_STARTED_CHANNEL}':`, message)
      try {
        const payload = JSON.parse(message)
        await handleViewStarted(payload)
        await redis.set(LAST_SUCCESSFUL_JOB, `view:${payload.fileHash}`)
        await redis.incr(JOB_COUNT)
        console.log(`Successfully recorded view for: ${payload.fileHash}`)
      } catch (err) {
        console.error(`Failed to process view, routing to DLQ: ${err.message}`)
        await routeToDLQ(message, err)
      }
    })

    app.listen(PORT, () => {
      console.log(`Health check server listening on port ${PORT}`)
    })
    console.log(`Listening for events on channels: [${TRANSCODE_CHANNEL}, ${VIEW_STARTED_CHANNEL}]`)
  } catch (err) {
    console.error('Failed to connect to Redis:', err)
    process.exit(1)
  }
}

startWorker()