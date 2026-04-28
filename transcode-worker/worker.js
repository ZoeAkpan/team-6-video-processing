import redis from 'redis';
import express from 'express';

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
const QUEUE_NAME = 'transcode-jobs';
const DEAD_LETTER_QUEUE_NAME = 'transcode-dead-letter';
const PORT = Number(process.env.PORT || 3004);
const VIDEO_PROCESSING_RATE = 1; // seconds of processing time per second of video duration
const CATALOG_DB_UPLOAD_ENDPOINT = "http://catalog-service:3002/new-video";

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

async function processJob(job) {

    // Sleep proportional to video duration
    const duration = parseInt(job.duration, 10);
    const processingTimeSeconds = duration * VIDEO_PROCESSING_RATE
    console.log(`job ${job.fileHash} processing for ${processingTimeSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, processingTimeSeconds * 1000));
    console.log(`job ${job.fileHash} processing complete`);

    // keep track of last completed job
    const finishedAt = new Date().toISOString();
    await client.set('transcode:lastJobAt', finishedAt);

    // add to Catalog DB 
    await fetch(CATALOG_DB_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
    });
    console.log("added video to catalog db");
    
    // publish transcode-complete event
    await client.publish('transcode-complete', JSON.stringify({
        fileHash: job.fileHash,
        originalFilename: job.originalFilename,
        contentType: job.contentType,
        fileSizeBytes: job.fileSizeBytes,
        uploadedBy: job.uploadedBy,
        status: 'complete',
        duration: job.duration,
        updatedAt: finishedAt,
    }));
    console.log("published transcode-complete event");

    console.log(`job ${job.fileHash} status=complete`);
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
            console.error(`Invalid job payload, adding to DLQ (${err.message})`, raw);
            await client.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        if (!job || !job.fileHash) {
            console.error('Invalid or missing fileHash in payload, adding to DLQ', parsed);
            await client.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        if (!job.originalFilename || 
            !job.contentType || 
            !job.fileSizeBytes || 
            !job.uploadedBy ||
            !job.duration ||
            !job.fileHash 
        ) {
            console.error('Invalid transcode job payload: missing required fields', job);
            await client.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        const duration = Number(job.duration)
        if (!Number.isFinite(duration) || duration <= 0) {
            console.error(`Invalid duration: ${job.duration}`, job);
            await client.lPush(DEAD_LETTER_QUEUE_NAME, raw); // Push to dead-letter queue
            continue;
        }

        try {
            await processJob(job);
        } catch (err) {
            console.error(`job ${job.fileHash} processing failed with error ${err.message}`);
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
