// to be pasted into compose file:

//   # quota-service:
//   #   build: ./quota-service
//   #   container_name: quota-service
//   #   restart: unless-stopped
//   #   ports:
//   #     - "3001:3001"          # expose on host for local testing
//   #   networks:
//   #     - team-net             # REQUIRED — makes it reachable from holmes
//   #   environment:
//   #     - DATABASE_URL=postgres://user:pass@postgres:5432/mydb
//   #     - REDIS_URL=redis://redis:6379
//   #   depends_on:
//   #     postgres:
//   #       condition: service_healthy
//   #     redis:
//   #       condition: service_healthy
//   #   healthcheck:
//   #     test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
//   #     interval: 10s
//   #     timeout: 5s
//   #     retries: 3
//   #     start_period: 15s

import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const app = express()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()

const startTime = Date.now()

app.get('/health', async (_req, res) => {
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
        service: "quota-service",
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        checks,
    }

    res.status(healthy ? 200 : 503).json(body)
})