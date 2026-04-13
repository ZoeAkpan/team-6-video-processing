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
  try {
    const result = await pool.query(
      `SELECT * FROM video WHERE status = 'available' ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`catalog-service running on port ${PORT}`));