// Sprint 2 — Baseline load test with caching enabled
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-2-cache.js
//
// Or from your host machine if k6 is installed:
//   k6 run k6/sprint-2-cache.js
//
// Replace TARGET_URL with your main read endpoint.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");
const cacheHitRate = new Rate("cache_hits");
const cacheMissRate = new Rate("cache_misses");

// ── Configuration ─────────────────────────────────────────────────────────────
// Update this URL to point to your main read endpoint.
// From inside the holmes container, use the service name (not localhost).
const TARGET_URL = "http://catalog-service:3002/videos";

export const options = {
  stages: [
    { duration: "30s", target: 20 }, // ramp up to 20 VUs
    { duration: "30s", target: 20 }, // sustain
    { duration: "10s", target: 0 }, // ramp down
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)"],
  thresholds: {
    http_req_failed: ["rate<0.05"], // keep request failures under 5%
    errors: ["rate<0.05"], // keep failed checks under 5%
  },
};

export default function () {
  const res = http.get(TARGET_URL, {
    tags: { endpoint: "videos-read" },
  });

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body is json-like": (r) => r.body.startsWith("[") || r.body.startsWith("{"),
  });

  const cacheHeader = "X-Cache";
  if (res.headers[cacheHeader]) {
    if (res.headers[cacheHeader] === "HIT") {
        cacheHitRate.add(1);
        cacheMissRate.add(0);
    } else if (res.headers[cacheHeader] === "MISS") {
        cacheHitRate.add(0);
        cacheMissRate.add(1);
    }
}

  errorRate.add(!ok);
  sleep(0.5);
}



