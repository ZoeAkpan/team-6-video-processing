import { createClient } from 'redis';

const client = createClient({ url: 'redis://redis:6379' });
const subscriber = createClient({ url: 'redis://redis:6379' }); 

const NUM_JOBS = 50;
const JOB_DURATION = 1; // seconds

client.on('error', (err) => {
    console.error('Redis client error:', err.message);
});

subscriber.on('error', (err) => {
    console.error('Redis subscriber error:', err.message);
});

async function runLoadTest(numJobs = 100, jobDuration = 1) {
    await client.connect();
    await subscriber.connect();

    console.log(`Starting load test with ${numJobs} jobs, each taking ${jobDuration}s`);

    const startTime = Date.now();

    let completedJobs = 0;

    let resolveAllJobs;
    const allJobsDone = new Promise((resolve) => {
        resolveAllJobs = resolve;
    });

    await subscriber.subscribe('transcode-complete', (message) => {
        const update = JSON.parse(message);
        if (update.status === 'complete') {
            completedJobs++;
            console.log(`Job ${update.jobId} completed. Total completed: ${completedJobs}/${numJobs}`);
        }

        if (completedJobs === numJobs) {
            // Fulfill promise to end test
            resolveAllJobs();
        }

    });

    // Measure time to queue all jobs
    const queueStart = Date.now();

    // Push jobs to queue
    for (let i = 0; i < numJobs; i++) {
        const jobId = `loadtest-${Date.now()}-${i}`;
        const job = {
            jobId,
            videoId: `video-${jobId}`,
            originalFilename: `test-video-${i}.mp4`,
            contentType: 'video/mp4',
            fileSizeBytes: 1024 * 1024,
            uploadedBy: 'loadtest-user',
            metadata: {
                duration: jobDuration,
            },
        };

        await client.hSet(`job:${jobId}`, 'status', 'pending');
        await client.lPush('transcode-jobs', JSON.stringify(job));
    }

    const queueEnd = Date.now();

    console.log(`All ${numJobs} jobs submitted to queue in ${(queueEnd - queueStart) / 1000}s`);

    await allJobsDone; // Wait for all jobs to complete

    const endTime = Date.now();
    const totalTime = (endTime - startTime) / 1000; // Seconds
    const throughput = numJobs / totalTime; // Jobs per second

    console.log(`\nLoad test completed:`);
    console.log(`Total time: ${totalTime.toFixed(2)}s`);
    console.log(`Throughput: ${throughput.toFixed(2)} jobs/second`);
    console.log(`Average job time: ${(totalTime / numJobs).toFixed(2)}s per job`);

    await subscriber.unsubscribe('transcode-updates');
    await subscriber.disconnect();
    await client.disconnect();
}

runLoadTest(NUM_JOBS, JOB_DURATION).catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});