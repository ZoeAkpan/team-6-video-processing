// Sprint 3 — Load test with poison pills mixed in
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-3-poison.js
//
// Or from your host machine if k6 is installed:
//   k6 run k6/sprint-3-poison.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";

const errorRate        = new Rate("errors");
const uploadsAccepted  = new Counter("uploads_accepted");
const uploadsRejected  = new Counter("uploads_rejected");
const poisonRejected   = new Counter("poison_pills_correctly_rejected");
const poisonAccepted   = new Counter("poison_pills_incorrectly_accepted");

const TARGET_URL = "http://upload-service:3000/upload";

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0  },
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)"],
  thresholds: {
    http_req_failed:                    ["rate<0.05"],
    errors:                             ["rate<0.05"],
    poison_pills_incorrectly_accepted:  ["count<1"],
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