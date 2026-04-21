import redis from 'redis';
import express from 'express';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'transcode-jobs';
const DEAD_LETTER_QUEUE_NAME = 'transcode-dead-letter';
const PORT = Number(process.env.PORT || 3004);

const app = express();
const client = redis.createClient({ url: redisUrl });
const queueClient = redis.createClient({ url: redisUrl });
const startTime = Date.now()
app.use(express.json());


client.on('error', (err) => {
    console.error('Worker Redis error:', err.message);
})

queueClient.on('error', (err) => {
    console.error('Queue Redis error:', err.message);
})

app.get('/health', async (req, res) => {
    // Check Redis
    const redisStart = Date.now();
    let redisStatus = {};
    let healthy = true;
    try {
        const pong = await client.ping();
        if (pong !== 'PONG') throw new Error(`unexpected response: ${pong}`);
        redisStatus = { status: 'healthy', latency_ms: Date.now() - redisStart };
    } catch (err) {
        redisStatus = { status: 'unhealthy', error: err.message };
        healthy = false;
    }

    let queueDepth = 0;
    let deadLetterQueueDepth = 0;
    let lastJobAt = null;
    
    // Queue metrics
    try {
        queueDepth = await client.lLen(QUEUE_NAME);
        deadLetterQueueDepth = await client.lLen(DEAD_LETTER_QUEUE_NAME);
        lastJobAt = await client.get('transcode:lastJobAt');
    } catch (err) {
        console.error('Error getting queue metrics:', err.message);
        healthy = false;
    }

    const body = {
        status: healthy ? 'healthy' : 'unhealthy',
        service: 'transcode-worker',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        redisStatus,
        queueDepth,
        deadLetterQueueDepth,
        lastJobAt,
    };

    res.status(healthy ? 200 : 503).json(body);
});

async function saveJobStatus(jobId, updates) {
    const key = `job:${jobId}`;
    await queueClient.hSet(key, updates);
    await queueClient.expire(key, 24 * 60 * 60); // set to expire after 1 day
}

async function processJob(job) {
    const key = `job:${job.jobId}`;
    const existing = await queueClient.hGetAll(key);

    if (!existing || Object.keys(existing).length === 0) {
        console.error(`Job record missing in Redis for ${job.jobId}, skipping`);
        return;
    }

    if (existing.status === 'complete') {
        console.log(`job=${job.jobId} already complete, skipping`);
        return;
    }

    if (existing.status === 'processing') {
        console.log(`job=${job.jobId} already processing, skipping`);
        return;
    }

    const startedAt = new Date().toISOString();
    await saveJobStatus(job.jobId, {
        status: 'processing',
        startedAt,
        updatedAt: startedAt,
    });

    // Sleep proportional to video duration
    const duration = parseInt(job.metadata.duration, 10);
    console.log(`job ${job.jobId} processing for ${duration}s`);
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    console.log(`job ${job.jobId} processing complete`);

    const finishedAt = new Date().toISOString();
    await saveJobStatus(job.jobId, {
        status: 'complete',
        updatedAt: finishedAt,
        finishedAt,
    });

    await queueClient.set('transcode:lastJobAt', finishedAt);

    await client.publish('transcode-complete', JSON.stringify({
        jobId: job.jobId,
        videoId: job.videoId,
        originalFilename: job.originalFilename,
        contentType: job.contentType,
        fileSizeBytes: job.fileSizeBytes,
        uploadedBy: job.uploadedBy,
        metadata: job.metadata,
        status: 'complete',
        updatedAt: finishedAt,
        finishedAt,
    }));

    console.log(`job=${job.jobId} status=complete`);
}

async function loop() {
    while (true) {
        const result = await queueClient.brPop(QUEUE_NAME, 0);
        const raw = result?.element;
        if (!raw) continue; // continue if response is null or empty

        let job;
        let parsed;

        try {
            parsed = JSON.parse(raw);
            job = parsed;
        } catch (err) {
            console.error('Invalid job payload:', err.message);
            continue;
        }

        if (!job || !job.jobId) {
            console.error('Invalid or missing jobId in payload', parsed);
            continue;
        }

        if (!job.videoId ||
            !job.originalFilename || 
            !job.contentType || 
            !job.fileSizeBytes || 
            !job.uploadedBy || 
            !job.metadata        
        ) {
            console.error('Invalid transcode job payload: missing required fields', job);
            await queueClient.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        if (!job.metadata.duration) {
            console.error('Invalid transcode job payload: missing duration in metadata', job);
            await queueClient.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        try {
            await processJob(job);
        } catch (err) {
            const updatedAt = new Date().toISOString();
            if (job && job.jobId) {
                await saveJobStatus(job.jobId, {
                    status: 'failed',
                    updatedAt,
                    error: err.message,
                });
                console.error(`job=${job.jobId} status=failed error=${err.message}`);
            } else {
                console.error(`unhandled worker error with invalid job payload: ${err.message}`);
            }
        }
    }
}

await client.connect();
await queueClient.connect();
app.listen(PORT, () => {
    console.log(`transcode-worker listening on port ${PORT}`);
});


// Async to prevent blocking of healthchecks
(async () => {
    await loop();
})();
