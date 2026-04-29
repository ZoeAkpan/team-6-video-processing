// Sprint 2 — Triggering async processing and caching results
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-2-async.js
//
// Or from your host machine if k6 is installed:
//   k6 run k6/sprint-2-async.js
//
// Replace TARGET_URL with your main read endpoint.

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";
 
const errorRate = new Rate("errors");
const uploadsAccepted = new Counter("uploads_accepted");
const uploadsRejected = new Counter("uploads_rejected");
 
const TARGET_URL = "http://upload-service:3000/upload";
 
export const options = {
  stages: [
    { duration: "30s", target: 20 }, // ramp up to 20 VUs
    { duration: "30s", target: 20 }, // sustain
    { duration: "10s", target: 0  }, // ramp down
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(95)", "p(99)"],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    errors:          ["rate<0.05"],
  },
};
 
export default function () {
  const uploadedBy = `user-${__VU}-${__ITER}`;
 
  const payload = JSON.stringify({
    originalFilename: `video-${__VU}-${__ITER}.mp4`,
    contentType:      "video/mp4",
    fileSizeBytes:    1000,
    uploadedBy,
    metadata: { duration: "1" }, 
  });
 
  const res = http.post(TARGET_URL, payload, {
    headers: { "Content-Type": "application/json" },
    tags:    { endpoint: "upload-async" },
  });
 
  const ok = check(res, {
    "status is 201":        (r) => r.status === 201,
    "upload was accepted":  (r) => {
      try {
        return JSON.parse(r.body).message === "Upload accepted";
      } catch {
        return false;
      }
    },
  });
 
  if (res.status === 201){
    uploadsAccepted.add(1);
  }
  else{                    
    uploadsRejected.add(1);
  }

  errorRate.add(!ok);
  sleep(0.5);
}
 