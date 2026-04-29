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


// ── Payload builders ──────────────────────────────────────────────────────────

function validPayload() {
  return {
    originalFilename: `video-${__VU}-${__ITER}.mp4`,
    contentType:      "video/mp4",
    fileSizeBytes:    1000,
    uploadedBy:       `user-${__VU}-${__ITER}`,
    fileHash:         `hash-${__VU}-${__ITER}-${Date.now()}`,
    duration:         1,
  };
}

const poisonPills = [
  // missing fileHash
  {
    label: "missing_fileHash",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    1000,
      uploadedBy:       "user-poison",
      duration:         1,
    },
    expectedStatus: 400,
  },
  // missing originalFilename
  {
    label: "missing_originalFilename",
    body: {
      contentType:   "video/mp4",
      fileSizeBytes: 1000,
      uploadedBy:    "user-poison",
      fileHash:      "poison-hash-1",
      duration:      1,
    },
    expectedStatus: 400,
  },
  // fileSizeBytes is zero
  {
    label: "fileSizeBytes_zero",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    0,
      uploadedBy:       "user-poison",
      fileHash:         "poison-hash-2",
      duration:         1,
    },
    expectedStatus: 400,
  },
  // fileSizeBytes is a string
  {
    label: "fileSizeBytes_string",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    "large",
      uploadedBy:       "user-poison",
      fileHash:         "poison-hash-3",
      duration:         42,
    },
    expectedStatus: 400,
  },
  // negative fileSizeBytes
  {
    label: "fileSizeBytes_negative",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    -500,
      uploadedBy:       "user-poison",
      fileHash:         "poison-hash-4",
      duration:         42,
    },
    expectedStatus: 400,
  },
  // empty uploadedBy
  {
    label: "uploadedBy_empty",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    1000,
      uploadedBy:       "",
      fileHash:         "poison-hash-5",
      duration:         42,
    },
    expectedStatus: 400,
  },
  // duration is zero
  {
    label: "duration_zero",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    1000,
      uploadedBy:       "user-poison",
      fileHash:         "poison-hash-6",
      duration:         0,
    },
    expectedStatus: 400,
  },
  // duration is negative
  {
    label: "duration_negative",
    body: {
      originalFilename: "video.mp4",
      contentType:      "video/mp4",
      fileSizeBytes:    1000,
      uploadedBy:       "user-poison",
      fileHash:         "poison-hash-7",
      duration:         -1,
    },
    expectedStatus: 400,
  },
  // completely empty body
  {
    label: "empty_body",
    body:           {},
    expectedStatus: 400,
  },
  // invalid JSON (sent as raw string)
  {
    label:          "invalid_json",
    raw:            "this is not json {{{",
    expectedStatus: 400,
  },
];

// ── Main test function ─────────────────────────────────────────────────────────

export default function () {
  // 70% normal requests, 30% poison pills
  const isPoison = Math.random() < 0.3;

  if (isPoison) {
    const pill = poisonPills[Math.floor(Math.random() * poisonPills.length)];
    const body = pill.raw ?? JSON.stringify(pill.body);

    const res = http.post(TARGET_URL, body, {
      headers: { "Content-Type": "application/json" },
      tags:    { endpoint: "upload", type: "poison", label: pill.label },
    });

    const ok = check(res, {
      [`poison [${pill.label}] rejected with ${pill.expectedStatus}`]: (r) =>
        r.status === pill.expectedStatus,
    });

    if (res.status === 400 || res.status === 403) {
      poisonRejected.add(1);
    } else {
      poisonAccepted.add(1);
      errorRate.add(1);
    }

  } else {
    const res = http.post(TARGET_URL, JSON.stringify(validPayload()), {
      headers: { "Content-Type": "application/json" },
      tags:    { endpoint: "upload", type: "valid" },
    });

    const ok = check(res, {
      "valid upload: status 201 or 200": (r) => r.status === 201 || r.status === 200,
      "valid upload: has message field":  (r) => {
        try { return !!JSON.parse(r.body).message; } catch { return false; }
      },
    });

    res.status === 201 ? uploadsAccepted.add(1) : uploadsRejected.add(1);
    errorRate.add(!ok);
  }

  sleep(0.5);
}