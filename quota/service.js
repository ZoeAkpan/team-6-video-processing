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

import express from 'express';
import redis from 'redis';
import pg from 'pg';

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT || '3001');

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
// const ttlSec = Number(process.env.TTL_SEC || '86400');
const postgresUrl = process.env.DATABASE_URL;

// postgres connection tool
const pool = new Pool({
    connectionString: postgresUrl,
});

pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message)
});

const client = redis.createClient({ url: redisUrl });

client.on('error', (err) => {
    console.error('API Redis error:', err.message)
});

app.use(express.json());

app.get('/health', async (_req, res) => {
    // make sure postgres connection is working
    try {
        await pool.query('SELECT 1')   // lightweight connectivity check
        res.status(200).json({ status: 'ok' })
    } catch (err) {
        res.status(503).json({ status: 'error', detail: err.message })
    }
});