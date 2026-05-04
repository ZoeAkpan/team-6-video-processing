// Sprint 4 - Replica failure test
//
// Start the replicated system, then run from inside Holmes:
//   BASE_URL=http://caddy:80 k6 run /workspace/k6/sprint-4-replica.js
//
// During the sustained stage, stop one replica:
//   docker stop $(docker compose ps -q quota-service | head -1)
//
// Restart it before the test ends:
//   docker compose up -d --scale upload-service=3 --scale quota-service=3 --scale catalog-service=3

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://caddy:80";
const ENDPOINT = __ENV.ENDPOINT || "/quota-service/quota/k6-sprint-4-user";
const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "120s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)"],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
  },
};

export default function () {
  const res = http.get(`${BASE_URL}${ENDPOINT}`, {
    tags: { endpoint: ENDPOINT, scenario: "replica-failure" },
  });

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body is json-like": (r) => r.body.startsWith("{") || r.body.startsWith("["),
    "quota response includes replica id": (r) => {
      try {
        return Boolean(r.json("serviceInstance"));
      } catch (_) {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  sleep(0.5);
}
