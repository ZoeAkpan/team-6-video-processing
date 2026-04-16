const express = require("express");
const { Pool } = require("pg");
const redis = require("redis");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});

redisClient.connect().catch(console.error);

app.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    db: "ok",
    redis: "ok",
  };

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    health.status = "unhealthy";
    health.db = "error: " + err.message;
  }

  try {
    await redisClient.ping();
  } catch (err) {
    health.status = "unhealthy";
    health.redis = "error: " + err.message;
  }

  const statusCode = health.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get("/videos", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM video WHERE status = 'available' ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/video/search", async (req,res) => {
  try {
    const {q} = req.query;
    if(!q) {
      return res.status(400).json({error:"missing search query"});
    }

    const result = await pool.query(
      `SELECT * FROM video WHERE title ILIKE $1 AND status = 'available' ORDER BY created_at DESC`, [`%${q}%1`]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message});
  }
})

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`catalog-service running on port ${PORT}`));