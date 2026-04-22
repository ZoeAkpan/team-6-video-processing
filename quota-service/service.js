import express from 'express'
import pg from 'pg'
import { createClient } from 'redis'

const { Pool } = pg

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://quota:quota@quota-db:5432/quota';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const DEFAULT_UPLOAD_LIMIT_COUNT = Number(process.env.DEFAULT_UPLOAD_LIMIT_COUNT || 10);
const DEFAULT_STORAGE_LIMIT_BYTES = Number(process.env.DEFAULT_STORAGE_LIMIT_BYTES || 1073741824);

const pool = new Pool({
  connectionString: DATABASE_URL,
});

const redis = createClient({
  url: REDIS_URL,
});

redis.on('error', (err) => {
  console.error(
    JSON.stringify({
      event: 'redis_error',
      message: err.message,
      timestamp: new Date().toISOString(),
    })
  );
});

function validateQuotaCheckBody(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push('request body must be a JSON object');
    return errors;
  }

  if (!body.userId || typeof body.userId !== 'string' || !body.userId.trim()) {
    errors.push('userId is required and must be a non-empty string');
  }

  if (!Number.isInteger(body.fileSizeBytes) || body.fileSizeBytes <= 0) {
    errors.push('fileSizeBytes is required and must be a positive integer');
  }

  if (
    body.fileHash !== undefined &&
    (typeof body.fileHash !== 'string' || !body.fileHash.trim())
  ) {
    errors.push('fileHash must be a non-empty string when provided');
  }

  return errors;
}

async function ensureQuotaRow(userId) {
  await pool.query(
    `
    INSERT INTO quotas (
      user_id,
      upload_count,
      upload_limit_count,
      storage_used_bytes,
      storage_limit_bytes
    )
    VALUES ($1, 0, $2, 0, $3)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [userId, DEFAULT_UPLOAD_LIMIT_COUNT, DEFAULT_STORAGE_LIMIT_BYTES]
  );
}

app.get('/health', async (_req, res) => {
  let db = 'error';
  let redisStatus = 'error';

  try {
    await pool.query('SELECT 1');
    db = 'ok';
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'db_health_error',
        message: err.message,
        timestamp: new Date().toISOString(),
      })
    );
  }

  try {
    await redis.ping();
    redisStatus = 'ok';
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'redis_health_error',
        message: err.message,
        timestamp: new Date().toISOString(),
      })
    );
  }

  const healthy = db === 'ok' && redisStatus === 'ok';

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: 'quota-service',
    db,
    redis: redisStatus,
  });
});

app.post('/quota/check', async (req, res) => {
  try {
    const errors = validateQuotaCheckBody(req.body);

    if (errors.length > 0) {
      console.log(
        JSON.stringify({
          event: 'quota_check_rejected',
          reason: 'invalid_request',
          details: errors,
          requestBody: req.body,
          timestamp: new Date().toISOString(),
        })
      );

      return res.status(400).json({
        error: 'invalid_request',
        details: errors,
      });
    }

    const { userId, fileSizeBytes, fileHash } = req.body;

    await ensureQuotaRow(userId);

    const result = await pool.query(
      `
      SELECT
        user_id,
        upload_count,
        upload_limit_count,
        storage_used_bytes,
        storage_limit_bytes
      FROM quotas
      WHERE user_id = $1
      `,
      [userId]
    );

    const row = result.rows[0];

    const uploadCount = Number(row.upload_count);
    const uploadLimitCount = Number(row.upload_limit_count);
    const storageUsedBytes = Number(row.storage_used_bytes);
    const storageLimitBytes = Number(row.storage_limit_bytes);

    const remainingUploadSlots = Math.max(0, uploadLimitCount - uploadCount);
    const remainingBytes = Math.max(0, storageLimitBytes - storageUsedBytes);

    const allowedByCount = remainingUploadSlots > 0;
    const allowedByStorage = remainingBytes >= fileSizeBytes;
    const allowed = allowedByCount && allowedByStorage;

    let reason = 'ok';
    if (!allowedByCount) {
      reason = 'upload_limit_exceeded';
    } else if (!allowedByStorage) {
      reason = 'storage_limit_exceeded';
    }

    console.log(
      JSON.stringify({
        event: 'quota_checked',
        userId,
        fileHash: fileHash ?? null,
        requestedFileSizeBytes: fileSizeBytes,
        allowed,
        reason,
        uploadCount,
        uploadLimitCount,
        remainingUploadSlots,
        storageUsedBytes,
        storageLimitBytes,
        remainingBytes,
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(200).json({
      allowed,
      reason,
      userId,
      requestedFileSizeBytes: fileSizeBytes,
      uploadCount,
      uploadLimitCount,
      remainingUploadSlots,
      storageUsedBytes,
      storageLimitBytes,
      remainingBytes,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'quota_check_error',
        message: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(500).json({
      error: 'internal_server_error',
    });
  }
});

app.post('/quota/consume', async (req, res) => {
  const client = await pool.connect();

  try {
    const { userId, fileSizeBytes, fileHash } = req.body;

    const errors = [];

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      errors.push('userId is required and must be a non-empty string');
    }

    if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
      errors.push('fileSizeBytes is required and must be a positive integer');
    }

    if (!fileHash || typeof fileHash !== 'string' || !fileHash.trim()) {
      errors.push('fileHash is required and must be a non-empty string');
    }

    if (errors.length > 0) {
      console.log(
        JSON.stringify({
          event: 'quota_consume_rejected',
          reason: 'invalid_request',
          details: errors,
          requestBody: req.body,
          timestamp: new Date().toISOString(),
        })
      );

      return res.status(400).json({
        error: 'invalid_request',
        details: errors,
      });
    }

    await client.query('BEGIN');

    await client.query(
      `
      INSERT INTO quotas (
        user_id,
        upload_count,
        upload_limit_count,
        storage_used_bytes,
        storage_limit_bytes
      )
      VALUES ($1, 0, $2, 0, $3)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId, DEFAULT_UPLOAD_LIMIT_COUNT, DEFAULT_STORAGE_LIMIT_BYTES]
    );

    const insertConsumption = await client.query(
      `
      INSERT INTO quota_consumptions (user_id, file_hash, file_size_bytes)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, file_hash) DO NOTHING
      RETURNING user_id
      `,
      [userId, fileHash, fileSizeBytes]
    );

    const alreadyConsumed = insertConsumption.rowCount === 0;

    if (!alreadyConsumed) {
      await client.query(
        `
        UPDATE quotas
        SET
          upload_count = upload_count + 1,
          storage_used_bytes = storage_used_bytes + $2
        WHERE user_id = $1
        `,
        [userId, fileSizeBytes]
      );
    }

    const result = await client.query(
      `
      SELECT
        user_id,
        upload_count,
        upload_limit_count,
        storage_used_bytes,
        storage_limit_bytes
      FROM quotas
      WHERE user_id = $1
      `,
      [userId]
    );

    await client.query('COMMIT');

    const row = result.rows[0];

    console.log(
      JSON.stringify({
        event: 'quota_consumed',
        userId,
        fileHash,
        fileSizeBytes,
        consumed: !alreadyConsumed,
        idempotentReplay: alreadyConsumed,
        uploadCount: Number(row.upload_count),
        uploadLimitCount: Number(row.upload_limit_count),
        storageUsedBytes: Number(row.storage_used_bytes),
        storageLimitBytes: Number(row.storage_limit_bytes),
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(200).json({
      consumed: !alreadyConsumed,
      idempotentReplay: alreadyConsumed,
      userId,
      fileHash,
      uploadCount: Number(row.upload_count),
      uploadLimitCount: Number(row.upload_limit_count),
      storageUsedBytes: Number(row.storage_used_bytes),
      storageLimitBytes: Number(row.storage_limit_bytes),
    });
  } catch (err) {
    await client.query('ROLLBACK');

    console.error(
      JSON.stringify({
        event: 'quota_consume_error',
        message: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      })
    );

    return res.status(500).json({
      error: 'internal_server_error',
    });
  } finally {
    client.release();
  }
});

app.use((err, _req, res, _next) => {
  console.error(
    JSON.stringify({
      event: 'unhandled_error',
      message: err.message,
      stack: err.stack,
      timestamp: new Date().toISOString(),
    })
  );

  return res.status(500).json({
    error: 'internal_server_error',
  });
});

async function start() {
  try {
    await pool.query('SELECT 1');
    await redis.connect();

    app.listen(PORT, () => {
      console.log(
        JSON.stringify({
          event: 'quota_service_started',
          port: PORT,
          timestamp: new Date().toISOString(),
        })
      );
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'startup_error',
        message: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString(),
      })
    );
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(
    JSON.stringify({
      event: 'shutdown_started',
      signal,
      timestamp: new Date().toISOString(),
    })
  );

  try {
    if (redis.isOpen) {
      await redis.quit();
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'redis_shutdown_error',
        message: err.message,
        timestamp: new Date().toISOString(),
      })
    );
  }

  try {
    await pool.end();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'db_shutdown_error',
        message: err.message,
        timestamp: new Date().toISOString(),
      })
    );
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()