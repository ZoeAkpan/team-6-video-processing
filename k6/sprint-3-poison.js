// Sprint 3 — Poison-pill resilience test for the video pipeline
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-3-poison.js
//
// Or from your host machine if k6 is installed:
//   k6 run k6/sprint-3-poison.js
//
// After the test:
//   curl -s http://transcode-worker:3004/health | jq .
//   docker compose ps

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import redis from "k6/x/redis";

const uploadSuccessRate = new Rate("valid_upload_success_rate");
const validAfterPoisonSuccessRate = new Rate("valid_after_poison_success_rate");
const workerHealthRate = new Rate("worker_health_healthy_rate");
const dlqObservedRate = new Rate("dlq_observed_after_poison_rate");
const redisPoisonInjectionRate = new Rate("redis_poison_injection_success_rate");

const uploadsAccepted = new Counter("uploads_accepted");
const uploadsRejected = new Counter("uploads_rejected");
const edgePoisonRejected = new Counter("edge_poison_rejected");
const edgePoisonAccepted = new Counter("edge_poison_incorrectly_accepted");
const workerPoisonInjected = new Counter("worker_poison_pills_injected");
const workerPoisonInjectionFailed = new Counter("worker_poison_injection_failed");

const UPLOAD_URL = __ENV.UPLOAD_URL || "http://upload-service:3000/upload";
const WORKER_HEALTH_URL =
  __ENV.WORKER_HEALTH_URL || "http://transcode-worker:3004/health";
const REDIS_URL = __ENV.REDIS_URL || "redis://redis:6379";
const TRANSCODE_QUEUE = __ENV.TRANSCODE_QUEUE || "transcode-jobs";
const TRANSCODE_DLQ = __ENV.TRANSCODE_DLQ || "transcode-dead-letter";

const POISON_RATIO = Number(__ENV.POISON_RATIO || 0.25);
const EDGE_POISON_RATIO = Number(__ENV.EDGE_POISON_RATIO || 0.05);

const redisClient = new redis.Client(REDIS_URL);

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)"],
  thresholds: {
    checks: ["rate>0.90"],
    http_req_failed: ["rate<0.15"],
    http_req_duration: ["p(95)<2000"],
    // We want to ensure that the vast majority of valid uploads succeed, 
    // even with poison pills being injected
    valid_upload_success_rate: ["rate>0.95"],
    // We expect some valid uploads to fail after poison pills are injected,
    //  but the system should still be mostly functional
    valid_after_poison_success_rate: ["rate>0.90"],
    // worker remains healthy throughout the test
    worker_health_healthy_rate: ["rate>0.95"],
    redis_poison_injection_success_rate: ["rate>0.95"],
    dlq_observed_after_poison_rate: ["rate>0"],
  },
};

// Helper to generate unique IDs for uploads
function uniqueId(prefix) {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(
    Math.random() * 1000000
  )}`;
}

// ── Payload builders ──────────────────────────────────────────────────────────

// Generates a valid upload payload with unique fields to avoid deduplication
function validPayload(label = "normal") {
  const id = uniqueId(label);

  return {
    originalFilename: `${id}.mp4`,
    contentType: "video/mp4",
    fileSizeBytes: 1000,
    uploadedBy: `user-${id}`,
    fileHash: `hash-${id}`,
    duration: 1,
  };
}

// Poison pills designed to be rejected by upload service validation
const edgePoisonPills = [
  {
    label: "upload_missing_fileHash",
    body: {
      originalFilename: "poison.mp4",
      contentType: "video/mp4",
      fileSizeBytes: 1000,
      uploadedBy: "user-poison",
      duration: 1,
    },
  },
  {
    label: "upload_invalid_fileSizeBytes",
    body: {
      originalFilename: "poison.mp4",
      contentType: "video/mp4",
      fileSizeBytes: -1,
      uploadedBy: "user-poison",
      fileHash: "edge-poison-invalid-size",
      duration: 1,
    },
  },
  {
    label: "upload_invalid_json",
    raw: "this is not json {{{",
  },
];

// Poison pills designed to cause issues with worker processing 
const workerPoisonPills = [
  {
    label: "worker_invalid_json",
    raw: "this is not json {{{",
  },
  {
    label: "worker_missing_fileHash",
    body: {
      originalFilename: "bad-worker-job.mp4",
      contentType: "video/mp4",
      fileSizeBytes: 1000,
      uploadedBy: "user-poison",
      duration: 1,
    },
  },
  {
    label: "worker_missing_duration",
    body: {
      originalFilename: "bad-worker-job.mp4",
      contentType: "video/mp4",
      fileSizeBytes: 1000,
      uploadedBy: "user-poison",
      fileHash: "worker-poison-missing-duration",
    },
  },
  {
    label: "worker_zero_duration",
    body: {
      originalFilename: "bad-worker-job.mp4",
      contentType: "video/mp4",
      fileSizeBytes: 1000,
      uploadedBy: "user-poison",
      fileHash: "worker-poison-zero-duration",
      duration: 0,
    },
  },
  {
    label: "worker_empty_body",
    body: {},
  },
];

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch (_) {
    return null;
  }
}

function readDlqDepth(healthBody) {
  if (!healthBody) return null;
  return healthBody.dlq_depth ?? healthBody.deadLetterQueueDepth ?? null;
}

function readQueueDepth(healthBody) {
  if (!healthBody) return null;
  return healthBody.queue_depth ?? healthBody.queueDepth ?? null;
}

function sendValidUpload(label = "valid") {
  const res = http.post(UPLOAD_URL, JSON.stringify(validPayload(label)), {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "upload", type: "valid", label },
  });

  // Check for either 201 Created or 200 OK, as the service might 
  // return 200 for idempotent re-uploads
  const ok = check(res, {
    "valid upload accepted": (r) => r.status === 201 || r.status === 200,
    "valid upload has upload object": (r) => {
      const body = parseJson(r.body);
      return !!body?.upload;
    },
  });

  uploadSuccessRate.add(ok);

  if (ok) {
    uploadsAccepted.add(1);
  } else {
    uploadsRejected.add(1);
  }

  return ok;
}

function sendEdgePoison() {
  // Randomly select one of the edge poison pills to send
  const pill = edgePoisonPills[Math.floor(Math.random() * edgePoisonPills.length)];
  const body = pill.raw ?? JSON.stringify(pill.body);

  const res = http.post(UPLOAD_URL, body, {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "upload", type: "edge_poison", label: pill.label },
  });

  const rejected = check(res, {
    [`edge poison [${pill.label}] rejected`]: (r) =>
      r.status === 400 || r.status === 403,
  });

  if (rejected) {
    edgePoisonRejected.add(1);
  } else {
    edgePoisonAccepted.add(1);
  }
}

async function injectWorkerPoison() {
  // Randomly select one of the worker poison pills to inject
  const pill =
    workerPoisonPills[Math.floor(Math.random() * workerPoisonPills.length)];
  const body = pill.raw ?? JSON.stringify(pill.body);

  try {
    // Push the poison pill directly to the transcode queue in Redis
    await redisClient.rpush(TRANSCODE_QUEUE, body);
    workerPoisonInjected.add(1);
    redisPoisonInjectionRate.add(true);

    check(true, {
      [`worker poison [${pill.label}] pushed to transcode queue`]: (v) => v,
    });

    return true;
  } catch (err) {
    workerPoisonInjectionFailed.add(1);
    redisPoisonInjectionRate.add(false);
    console.error(`failed to inject worker poison pill [${pill.label}]: ${err}`);
    return false;
  }
}

function getWorkerHealth() {
  const res = http.get(WORKER_HEALTH_URL, {
    tags: { endpoint: "transcode_worker_health" },
  });
  const body = parseJson(res.body);

  const healthy = res.status === 200 && body?.status === "healthy";
  workerHealthRate.add(healthy);

  check(res, {
    "transcode worker health endpoint is healthy": () => healthy,
  });

  return {
    status: res.status,
    body,
    healthy,
    dlqDepth: readDlqDepth(body),
    queueDepth: readQueueDepth(body),
  };
}

export async function setup() {
  const health = getWorkerHealth();
  const initialDlqDepth = Number(await redisClient.llen(TRANSCODE_DLQ));

  console.log(
    `initial worker health: ${JSON.stringify({
      status: health.body?.status,
      queue_depth: health.queueDepth,
      dlq_depth: initialDlqDepth,
      last_job_at: health.body?.lastJobAt ?? health.body?.last_job_at ?? null,
    })}`
  );

  return { initialDlqDepth };
}

export default async function (data) {
  // Randomly decide whether to inject a worker poison pill and/or
  //  send an edge poison upload on this iteration
  const shouldInjectWorkerPoison = Math.random() < POISON_RATIO;
  const shouldSendEdgePoison = Math.random() < EDGE_POISON_RATIO;

  if (shouldInjectWorkerPoison) {
    const injected = await injectWorkerPoison();
    const validStillWorks = sendValidUpload("valid-after-worker-poison");
    validAfterPoisonSuccessRate.add(injected && validStillWorks);
  } else {
    sendValidUpload();
  }

  if (shouldSendEdgePoison) {
    sendEdgePoison();
  }

  // Periodically check worker health and DLQ depth to see 
  // if poison pills are having an impact
  if (__ITER % 10 === 0) {
    const health = getWorkerHealth();
    dlqObservedRate.add(
      Number(health.dlqDepth ?? 0) > Number(data.initialDlqDepth ?? 0)
    );
  }

  sleep(0.5);
}

export function teardown(data) {
  let finalHealth = getWorkerHealth();

  // If we don't see an increase in DLQ depth yet, wait a bit and check again
  for (let i = 0; i < 10; i += 1) {
    const dlqDepth = Number(finalHealth.dlqDepth ?? 0);
    if (dlqDepth > Number(data.initialDlqDepth ?? 0)) {
      break;
    }

    sleep(1);
    finalHealth = getWorkerHealth();
  }

  const initialDlqDepth = Number(data.initialDlqDepth ?? 0);
  const finalDlqDepth = Number(finalHealth.dlqDepth ?? 0);
  const dlqIncreased = finalDlqDepth > initialDlqDepth;

  dlqObservedRate.add(dlqIncreased);

  check(finalHealth, {
    "final worker status is healthy": (h) => h.healthy,
    "final worker dlq_depth is non-zero": () => finalDlqDepth > 0,
    "final worker dlq_depth increased during test": () => dlqIncreased,
  });

  console.log(
    `final worker health: ${JSON.stringify({
      status: finalHealth.body?.status,
      queue_depth: finalHealth.queueDepth,
      dlq_depth: finalDlqDepth,
      dlq_depth_before_test: initialDlqDepth,
      last_job_at:
        finalHealth.body?.lastJobAt ?? finalHealth.body?.last_job_at ?? null,
    })}`
  );
}
