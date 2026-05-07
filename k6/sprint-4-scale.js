// Sprint 4 - Scaling comparison

// Brief instructions:
// Run from inside Holmes:
//   BASE_URL=http://caddy:80 k6 run --env SCALE=single /workspace/k6/sprint-4-scale.js
//   BASE_URL=http://caddy:80 k6 run --env SCALE=replicated /workspace/k6/sprint-4-scale.js
//
// Run from the host:
//   BASE_URL=http://localhost:80 k6 run --env SCALE=single k6/sprint-4-scale.js
//   BASE_URL=http://localhost:80 k6 run --env SCALE=replicated k6/sprint-4-scale.js

// Detailed instructions:
// 1. Ensure k6 is downloaded on your machine (brew install k6)
// 2. Make sure all services are running: `docker compose up -d`
// 3. Apply the quota-service DB schema if you haven't already (docker compose exec -T quota-db psql -U quota -d quota < quota-service/db/schema.sql)
// 4. Check to see if quota service is even running: `curl http://localhost:80/quota-service/quota/k6-sprint-4-user` (should return 200 with a JSON body)
// 5. Now, run the k6 tests with commands:
  // BASE_URL=http://caddy:80 k6 run --env SCALE=single /workspace/k6/sprint-4-scale.js
  // BASE_URL=http://caddy:80 k6 run --env SCALE=replicated /workspace/k6/sprint-4-scale.js

  
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://caddy:80";
const ENDPOINT = __ENV.ENDPOINT || "/quota-service/quota/k6-sprint-4-user";
const SCALE = __ENV.SCALE || "unspecified";
const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "60s", target: 50 },
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
    tags: { endpoint: ENDPOINT, scale: SCALE },
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
