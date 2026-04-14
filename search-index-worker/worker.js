import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CHANNEL = 'transcode_complete';

async function startWorker() {
  console.log('Starting Search Index Worker...');
  const subscriber = createClient({ url: REDIS_URL });
  subscriber.on('error', (err) => console.error('Redis Client Error:', err));

  try {
    await subscriber.connect();
    console.log(`Connected to Redis at ${REDIS_URL}`);
    await subscriber.subscribe(CHANNEL, (message) => {
      console.log(`Received message on '${CHANNEL}':`, message);
      
      try {
        const payload = JSON.parse(message);
        console.log('Processing video metadata:', payload);
      } catch (err) {
        console.error('Failed to parse message payload:', err.message);
      }
    });

    console.log(`Listening for events on channel: ${CHANNEL}`);
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
  }
}

startWorker();