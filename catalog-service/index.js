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
const redisSub = redisClient.duplicate();
redisSub.connect().catch(console.error);
const DLQ_KEY = "catalog:dlq";

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
    const cached = await redisClient.get("catalog:videos:available");
    if (cached) {
      console.log("[cache hit] /videos served from Redis");
      return res.json(JSON.parse(cached));
    }

    console.log("[cache miss] /videos querying DB");
    const result = await pool.query(
      `SELECT * FROM video WHERE status = 'available' ORDER BY created_at DESC`
    );
    await redisClient.setEx("catalog:videos:available", 60, JSON.stringify(result.rows));
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
      `SELECT * FROM video WHERE title ILIKE $1 AND status = 'available' ORDER BY created_at DESC`, [`%${q}%`]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message});
  }
})
redisSub.subscribe("video.rejected", async (message) => {
  try {
    const { video_id } = JSON.parse(message);
    await pool.query(`UPDATE video SET status = 'unavailable' WHERE id = $1`, [video_id]);
    await redisClient.del("catalog:videos:available");
    console.log(`[moderation-sub] marked video ${video_id} as unavailable`);
  } catch (err) {
    console.error("[moderation-sub] error:", err.message);
  }
});

app.get("/video/:id", async (req, res) => {
  const {id} = req.params;

  try {
    const cached = await redisClient.get(`video: ${id}`);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query(
      `SELECT * FROM video WHERE id = $1 AND status = 'available'`, [id]
    )

    if (result.rows.length === 0){
      return res.status(404).json({ error: "video not found"});
    }

    const video = result.rows[0];
    await redisClient.set(`video:${id}`, JSON.stringify(video), {EX:60});
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message});
  }
})

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`catalog-service running on port ${PORT}`));