const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", db: "ok" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", db: "error: " + err.message });
  }
});

app.get("/videos", async (req, res) => {
  res.json([
    { id: 1, title: "Sample Video 1", owner_id: "user1", status: "pending" },
    { id: 2, title: "Sample Video 2", owner_id: "user2", status: "ready" },
  ]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`catalog-service running on port ${PORT}`));