import express from 'express'
import { createClient } from 'redis'

const app = express()
const port = Number(process.env.PORT ?? 3002)
const defaultQuotaBytes = Number(process.env.DEFAULT_QUOTA_BYTES ?? 500000000)
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const startTime = Date.now()
app.use(express.json())

app.get('/health', async (_req, res) => {
  const checks = {}
  let healthy = true

  // Check PostgreSQL
    // const dbStart = Date.now()
    // try {
    //     await pool.query('SELECT 1')
    //     checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart }
    // } catch (err) {
    //     checks.database = { status: 'unhealthy', error: err.message }
    //     healthy = false
    // }

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
    service: process.env.SERVICE_NAME ?? 'quota-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  }

  res.status(healthy ? 200 : 503).json(body)
})
app.post('/quota/check', async (req, res) => {
  const { userId, fileSizeBytes } = req.body ?? {}

  if (!userId || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    return res.status(400).json({
      error: 'userId and positive numeric fileSizeBytes are required',
    })
  }

  const usedBytesRaw = await redis.get(`quota:${userId}:used_bytes`)
  const usedBytes = Number(usedBytesRaw ?? 0)
  const remainingBytes = Math.max(defaultQuotaBytes - usedBytes, 0)
  const allowed = fileSizeBytes <= remainingBytes

  return res.json({
    userId,
    allowed,
    quotaBytes: defaultQuotaBytes,
    usedBytes,
    remainingBytes,
  })
})

app.post('/quota/consume', async (req, res) => {
  const { userId, fileSizeBytes } = req.body ?? {}

  if (!userId || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    return res.status(400).json({
      error: 'userId and positive numeric fileSizeBytes are required',
    })
  }

  const usedBytes = await redis.incrBy(`quota:${userId}:used_bytes`, fileSizeBytes)

  return res.json({
    userId,
    usedBytes,
    quotaBytes: defaultQuotaBytes,
    remainingBytes: Math.max(defaultQuotaBytes - usedBytes, 0),
  })
})


app.listen(port, () => {
  console.log(`quota-service listening on port ${port}`)
})
