// code from health endpoint section 

import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const quotaServiceUrl = process.env.QUOTA_SERVICE_URL ?? 'http://quota-service:3002'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const startTime = Date.now()
app.use(express.json())

async function checkQuota(userId, fileSizeBytes) {
  const response = await fetch(`${quotaServiceUrl}/quota/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, fileSizeBytes }),
  })

  const payload = await response.json()

  if (!response.ok) {
    const error = new Error(payload.error ?? 'quota check failed')
    error.status = response.status
    throw error
  }

  return payload
}

async function consumeQuota(userId, fileSizeBytes) {
  const response = await fetch(`${quotaServiceUrl}/quota/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, fileSizeBytes }),
  })

  if (!response.ok) {
    const payload = await response.json()
    const error = new Error(payload.error ?? 'quota consumption failed')
    error.status = response.status
    throw error
  }
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

app.listen(port, () => {
  console.log(`upload-service listening on port ${port}`)
})
