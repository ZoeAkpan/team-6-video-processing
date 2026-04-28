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
const subscriber = redisClient.duplicate();
subscriber.connect().catch(console.error);

subscriber.subscribe("transcode_complete", async (message) => {console.log("[transcode_complete] received message:", message);
  let data;
  try{
    data = JSON.parse(message);
  } catch (err) {
    console.error("[poison pill] invalid, moving to DLQ", message);
    await redisClient.lPush(DLQ_KEY, message);
    return;
  }
  if (!data.fileHash || !data.resolution) {
    console.error("[poison pill] missing required fields, moving to DLQ:", message);
    await redisClient.lPush(DLQ_KEY, message);
    return;
  }
  
  try{
    const video = await pool.query(
      `SELECT id FROM video WHERE fileHash = $1`,
      [data.fileHash]
    );
    if (video.rows.length === 0) {
      console.error("[poison pill] video not found for fileHash:", data.fileHash, "moving to DLQ");
      await redisClient.lPush(DLQ_KEY, message);
      return;
    }
    const videoId = video.rows[0].id;
    await pool.query(
      `INSERT INTO transcode_output (video_id, resolution) VALUES ($1, $2) ON CONFLICT (video_id, resolution) DO NOTHING`,
      [videoId, data.resolution]
    );
    await pool.query(
      `UPDATE video SET status = 'available' WHERE id = $1`,
      [videoId]
    );
    await redisClient.del("catalog:videos:available");
    await redisClient.set("catalog:last_processed_at", new Date().toISOString());
    console.log("[transcode_complete] video", videoId, "status updated to available");
  } catch (err) {
    console.error("[poison pill] DB error, moving to DLQ:", err.message);
    await redisClient.lPush(DLQ_KEY, message);
  }
});

app.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    db: "ok",
    redis: "ok",
    dlq_depth: 0,
    last_processed_at: null,
  };

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    health.status = "unhealthy";
    health.db = "error: " + err.message;
  }

  try {
    await redisClient.ping();
    health.dlq_depth = await redisClient.lLen(DLQ_KEY);
    const last = await redisClient.get("catalog: last_procesed_at");
    health.last_processed_at = lat || null;
  } catch (err) {
    health.status = "unhealthy";
    health.redis = "error: " + err.message;
  }

  try {
    health.dlq_depth = await redisClient.lLen(DLQ_KEY);
  } catch (err) {
    health.dlq_depth = -1;
  }
  const statusCode = health.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get("/videos", async (req, res) => {
  try {
    const cached = await redisClient.get("catalog:videos:available");
    if (cached) {
      try {
        console.log("[cache hit] /videos served from Redis");
        return res.json(JSON.parse(cached));
      } catch (e) {
        console.warn("[cache] corrupted JSON in catalog:videos:available, deleting");
        await redisClient.del("catalog:videos:available");
      }
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
async function handleRejection(message, attempt = 1) {
  try {
    const parsed = JSON.parse(message);
    const { fileHash } = parsed;
    if (!fileHash) throw new Error("missing fileHash");

    await pool.query(
      `UPDATE video SET status = 'unavailable' WHERE file_hash = $1`,
      [fileHash]
    );
    await redisClient.del("catalog:videos:available");
    console.log(`[moderation-sub] marked video ${fileHash} as unavailable`);
  } catch (err) {
    if (attempt < 3) {
      const delay = Math.pow(2, attempt) * 100;
      console.warn(`[moderation-sub] retry ${attempt}/3 in ${delay}ms — ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      return handleRejection(message, attempt + 1);
    }
    console.error(`[moderation-sub] sending to DLQ after 3 attempts — ${err.message}`);
    await redisClient.lPush(
      DLQ_KEY,
      JSON.stringify({ message, error: err.message, at: new Date().toISOString() })
    );
  }
}

redisSub.subscribe("video-rejected", (message) => handleRejection(message));

app.get("/video/:id", async (req, res) => {
  const {id} = req.params;

  try {
    const cached = await redisClient.get(`video:${id}`);
    if (cached) {
      try{
        const parsed = JSON.parse(cached);
        console.log(`[cache hit] /videos/${id} served from Redis`);
        return res.json(parsed);
      } catch (err) {
        console.error(`[cached corruption] invalid JSON for video:${id}, deleting`);
        await redisClient.del(`video:${id}`);
      }
    }
    console.log(`[cache miss] /videos/${id} querying DB`);
    const result = await pool.query(
      `SELECT * FROM video WHERE id = $1 AND status = 'available'`, [id]
    );

    if (result.rows.length === 0){
      return res.status(404).json({ error: "video not found"});
    }

    const video = result.rows[0];
    await redisClient.set(`video:${id}`, JSON.stringify(video), {EX:60});
    res.json(video);
  } catch (err) {
    res.status(500).json({ error: err.message});
  }
})

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`catalog-service running on port ${PORT}`));