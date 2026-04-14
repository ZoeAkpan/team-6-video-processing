import redis from 'redis'

const redisUrl = process.env.REDIS_URL || 'redis://redis:6379'
const queueName = 'transcode-jobs'
const PORT = Number(process.env.PORT || 3004)

const client = redis.createClient({ url: redisUrl })

client.on('error', (err) => {
    console.error('Worker Redis error:', err.message)
})

async function saveJobStatus(jobId, updates) {
    const key = `job:${jobId}`
    await client.hSet(key, updates)
    await client.expire(key, 24 * 60 * 60) // set to expire after 1 day
}

async function processJob(job) {
    const key = `job:${job.jobId}`;
    const existing = await client.hGetAll(key);

    if (!existing || Object.keys(existing).length === 0) {
        console.error(`Job record missing in Redis for ${job.jobId}, skipping`);
        return;
    }

    if (existing.status === 'done') {
        console.log(`job=${job.jobId} already done, skipping`);
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
    const duration = parseInt(job.duration, 10);
    console.log(`job ${job.jobId} processing for ${duration}s`);
    await new Promise((resolve) => setTimeout(resolve, duration * 1000));
    console.log(`job ${job.jobId} processing complete`);

    const finishedAt = new Date().toISOString();
    await saveJobStatus(job.jobId, {
        status: 'done',
        updatedAt: finishedAt,
        finishedAt,
    });

    await client.publish('transcode-updates', JSON.stringify({
        // TODO: adjust field names when job schema is finalized
        jobId: job.jobId,
        videoId: job.videoId,
        status: 'done',
        updatedAt: finishedAt,
        outputFormats: job.outputFormats || [],
    }));

    console.log(`job=${job.jobId} status=done`);
}

async function loop() {
    while (true) {
        const result = await client.brPop(queueName, 0)
        const raw = result?.element
        if (!raw) continue // continue if response is null or empty

        let job
        let parsed

        try {
            parsed = JSON.parse(raw)
            job = parsed
        } catch (err) {
            console.error('Invalid job payload:', err.message)
            continue
        }

        if (!job || !job.jobId) {
            console.error('Invalid or missing jobId in payload', parsed)
            continue
        }

        // Check for malformed fields -> push to dead-letter queue
        if (!job.videoId || !job.duration || !job.sourcePath) {
            console.error('Invalid transcode job payload: missing required fields', job)
            await client.lPush('transcode-dead-letter', raw) // Push to dead-letter queue
            continue
        }

        try {
            await processJob(job)
        } catch (err) {
            const updatedAt = new Date().toISOString()
            if (job && job.jobId) {
                await saveJobStatus(job.jobId, {
                    status: 'failed',
                    updatedAt,
                    error: err.message,
                })
                console.error(`job=${job.jobId} status=failed error=${err.message}`)
            } else {
                console.error(`unhandled worker error with invalid job payload: ${err.message}`)
            }
        }
    }
}

await client.connect()
console.log(`transcode-worker listening on port ${PORT}`)
await loop()

