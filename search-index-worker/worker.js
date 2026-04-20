import { createClient } from 'redis'
import pg from 'pg'
import express from 'express'

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL,})
const app = express()
const PORT = Number(process.env.PORT || 3006)
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const CHANNEL = process.env.TRANSCODE_COMPLETE_CHANNEL || 'transcode_complete'
const redis = createClient({ url: REDIS_URL })
const subscriber = createClient({ url: REDIS_URL })

redis.on('error', (err) => console.error('Redis error:', err.message))
subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message))

app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1')
    await redis.ping()

    res.status(200).send('ok')
  } catch (err) {
    console.error('Health check failed:', err.message)
    res.status(500).send('unhealthy')
  }
})

async function handleIndexing(payload) {
  const { video_id, title, description } = payload
  
  const query = `
    INSERT INTO video_search_index (video_id, title, description, indexed_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (video_id) DO UPDATE 
    SET title = EXCLUDED.title, 
        description = EXCLUDED.description, 
        indexed_at = NOW();
  `

  await pool.query(query, [video_id, title, description])
  console.log(`Successfully indexed video: ${video_id}`)
}

// How to test locally for now: 
// send a request: 
// docker compose exec holmes redis-cli -h redis publish transcode_complete '{"video_id": "v-123", "title": "Inception", "description": "A dream within a dream"}'
// view table: 
// docker compose exec search-db psql -U user -d search -c "SELECT * FROM video_search_index;"
// send another request: 
// docker compose exec holmes redis-cli -h redis publish transcode_complete '{"video_id": "v-456", "title": "Planet Earth", "description": "A deep dive into the ocean depths."}'
// docker compose exec holmes redis-cli -h redis publish transcode_complete '{"video_id": "v-789", "title": "Docker for Beginners", "description": "Learn how to containerize your apps."}'
// send same request to test idempotency: 
// docker compose exec holmes redis-cli -h redis publish transcode_complete '{"video_id": "v-123", "title": "Inception (Extended Cut)", "description": "Now with 20 minutes of extra dreams!"}'
//logs:
//docker compose logs -f search-index-worker


async function startWorker() {
  console.log('Starting Search Index Worker...')
  const subscriber = createClient({ url: REDIS_URL })
  subscriber.on('error', (err) => console.error('Redis Client Error:', err))

  try {
    await redis.connect()
    await subscriber.connect()
    console.log(`Connected to Redis at ${REDIS_URL}`)
    await subscriber.subscribe(CHANNEL, async (message) => {
    console.log(`Received message '${CHANNEL}':`, message)
      try {
        const payload = JSON.parse(message)
        await handleIndexing(payload)
      } catch (err) {
        console.error('Failed to parse message payload:', err.message)
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

startWorker()