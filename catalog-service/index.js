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
      `SELECT 1 FROM video WHERE file_hash = $1`,
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
    health.last_processed_at = last || null;
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

app.post("/add-video", async (req, res) => {
  console.log(`got a request to add a video to catalog db`)
  // error checking: make sure the request body has the necessary fields
  const expectedFields = [
    'originalFilename',
    'contentType',
    'fileSizeBytes',
    'uploadedBy',
    'fileHash',
    'duration',
  ]
  if (!expectedFields.every((field) => field in req.body)) {
    console.log("invalid request body, returning 400")
    return res.status(400).json({
      error:
        'missing fields from request body: originalFilename, contentType, fileSizeBytes, uploadedBy, fileHash, duration',
    })
  }

  const {
    originalFilename,
    contentType,
    fileSizeBytes,
    uploadedBy,
    fileHash,
    duration,
  } = req.body

  console.log(`file hash is ${fileHash}`)

  // make sure this fileHash is not already in the catalog db (should never have to worry about this)
  const rows = await pool.query(
    `SELECT 1 FROM video WHERE file_hash = $1`,
    [fileHash]
  )
  if (rows.length > 0) {
    console.log("video with that file hash already exists")
    return res.status(401).json({
      error: 'video already exists in catalog, cannot reupload',
    })
  }

  // add video to catalog db
  try {
    await pool.query(
      `INSERT INTO video (
        file_hash,
        original_filename,
        content_type,
        file_size_bytes,
        uploaded_by,
        duration
      )
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [fileHash, originalFilename, contentType, fileSizeBytes, uploadedBy, duration]
    )

    console.log("added to database")
    return res.status(200).json({
      message: "upload to catalog db accepted",
    })
  } catch (err) {
    console.error(`error adding to database: ${err.message}`)
    return res.status(500).json({
      error: `database error: ${err.message}`,
    })
  }
  
})

app.post("/mod-result", async (req, res) => {
  console.log(`got a request to update a video's moderation status`)
  // error checking: make sure the request body has the necessary fields
  const expectedFields = [
    'fileHash',
    'status',
  ]
  if (!expectedFields.every((field) => field in req.body)) {
    console.log("invalid request body, returning 400")
    return res.status(400).json({
      error:
        'missing fields from request body: fileHash and status',
    })
  }

  const { fileHash, status } = req.body
  console.log(`file hash is ${fileHash}`)

  // make sure this fileHash IS already in the catalog db (should never have to worry about this)
  const rows = await pool.query(
    `SELECT 1 FROM video WHERE file_hash = $1`,
    [fileHash]
  )
  if (rows.length === 0) {
    console.log("no videos in catalog db with that file hash")
    return res.status(401).json({
      error: 'no video with that file hash found in catalog',
    })
  }

  // update video's moderation status
  try {
    await pool.query(
      `UPDATE video SET moderation_status = $1, updated_at = NOW() WHERE file_hash = $2`,
      [status, fileHash]
    )

    console.log(`moderation status set in database to ${status}`)
    return res.status(200).json({
      message: "moderation status recorded",
    })
  } catch (err) {
    console.error(`error updating database: ${err.message}`)
    return res.status(500).json({
      error: `database error: ${err.message}`,
    })
  }
  
})

app.post("/thumbnail", async (req, res) => {
  console.log(`got a request to add a thumbnail for a video`)
  // error checking: make sure the request body has the necessary fields
  const expectedFields = ["fileHash", "thumbnailUrl", "timestampSeconds"]
  if (!expectedFields.every((field) => field in req.body)) {
    console.log("invalid request body, returning 400")
    return res.status(400).json({
      error:
        'missing fields from request body: fileHash, thumbnailUrl, and timestampSeconds',
    })
  }

  const { fileHash, thumbnailUrl, timestampSeconds } = req.body
  console.log(`file hash is ${fileHash}`)

  // make sure this fileHash IS already in the catalog db (should never have to worry about this)
  const rows = await pool.query(
    `SELECT 1 FROM video WHERE file_hash = $1`,
    [fileHash]
  )
  if (rows.length === 0) {
    console.log("no videos in catalog db with that file hash")
    return res.status(401).json({
      error: 'no video with that file hash found in catalog',
    })
  }

  // add this thumbnail to thumbnail table
  try {
    await pool.query(
      `
        INSERT INTO thumbnail (file_hash, thumbnail_url, timestamp_seconds)
        VALUES ($1, $2, $3)
        ON CONFLICT (file_hash, timestamp_seconds)
        DO UPDATE SET thumbnail_url = EXCLUDED.thumbnail_url
      `,
      [fileHash, thumbnailUrl, timestampSeconds]
    )

    console.log("thumbnail added to database")
    return res.status(200).json({
      message: "thumbnail added to database",
    })
  } catch (err) {
    console.error(`error updating database: ${err.message}`)
    return res.status(500).json({
      error: `database error: ${err.message}`,
    })
  }
  
})

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