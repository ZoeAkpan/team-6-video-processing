# Sprint 3 Report — Team 6

**Sprint:** 3 — Reliability and Poison Pills  
**Tag:** `sprint-3`  
**Submitted:** [date, before 04.28 class]

---

## What We Built

[What failure scenarios does the system now handle? Which queues have DLQ handling? What happens when a poison pill is injected?]

All worker queues have dead letter queue handling. Messages that failed processing are routed to a DLQ rather than crashing or blocking a queue. The thumbnail, moderation, and search index workers validate incoming events and also move poison pills to appropriate DLQs. All worker health endpoints expose dlq_depth. Catalog service retries failed events before sending to its DLQ and helps to protect the Redis cache against messed-up JSON objects. Upload service has idempotency by fileHash and involves synchronization with quota before enqueuing transcode jobs. 

---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| [Jahnavi Sharma]      | Added DLQ handling to video.rejected pub/sub subscriber - failed messages retry up to 3 times with exponential backoff (200ms, 400ms) before being pushed to catalog:dlq Redis list with error and timestamp. Exposed dlq_depth in GET /health. Added poison pill protection to GET /videos cache - corrupted JSON deletes the key and falls back to DB. Fixed cache key typo in GET /video/:id. | 44dac0e, a3eb115, f301fe3, 3f742e6 |
| [Jihyun Kim]      | Hardened `quota-service` for Sprint 3 reliability. Added transactional quota handling with row locking in `POST /quota/consume`, added `POST /quota/release` for compensating rollback when upload succeeds but transcode enqueue fails, and added `GET /quota/:userId` for quota inspection. Updated `upload-service` to use DB-backed duplicate detection by `file_hash` instead of relying only on Redis, and added upload state tracking | `4131ecd`, `35d2430`, `96b8a13` |
| [Anne-Colombe Sinkpon]      | Added graceful failure handling to thumbnail-worker.Added poison-pill validation for malformed transcode-complete events.Moved bad thumbnail messages to the Redis dead letter queue instead of crashing or retrying forever. Added CPU-bound thumbnail extraction simulation using a busy-wait loop. Added random jitter to thumbnail CPU simulation for more realistic load behavior.| c3a9191, 3da5721, 17c53ad, 821ef40, ea64247 |
| Zoë Akpan | Fixed QUEUE_NAME default bug in thumbnail worker (thumbnail-jobs:dlq → thumbnail-jobs), renamed health response field to dlq_depth per spec, added moveToDeadLetterSafely wrapper to prevent cascading errors when DLQ writes fail, verified upload service is performing real Postgres writes.|`8f8d55e`, `162e20a`|
| Nishil Adina | Rewired main transcode pipeline, which added `/thumbnail`, `/add-video`, and `/mod-result` endpoints to catalog-service. Added poison pill handling and DLQ to moderation worker, updated moderation DB schema, updated `/health` endpoint and added `/dlq` endpoint to moderation worker. Produced flowchart documentation. | 645e400, 6bdbcb0, d224394, 6574e43, PR 54 |
| Gabriella Wang | Added poison pill and DLQ handling, when the message is invalid, it is moved to Redis list search-index-worker:dlq. Updated health endpoint to include dlq_depth, last_successful_job, jobs_completed, uptime. Fixed the schema of the search database and the subscription in search-index-worker to match the new structure. Primarily replacing video-id to fileHash, updating new columns, and getting rid of the metadata subgroup. | `3e5ab24`, `8ce6484` |
| [Sebastian Vaskes Pimentel] | Improved `playback-service` compatibility and reliability by accepting legacy and updated JSON field names, normalizing request fields internally, and returning cleaner `400` responses for malformed playback requests. Also reviewed playback behavior against the recent JSON format changes and helped finalize report/documentation updates. | `cef0a9d` | 
| Duyen Tran | Added transcode_complete pub/sub subscriber with poison pill handing, and console.log to know if it is being rejected or not. Updated catalog db to more align with other services. Updated health endpoint for dlq. Added poison pill protection to Redis cache on /video/:id. | `5d5d8dc`, `357819f` |
| Robert Winfield | Ensured DLQ functionality in transcode-worker. Modified transcode-complete message object structure to match that of other services. Implemented file hash-based ID. | `fd4b3c8`, `3a27d0b` |
---

## What Is Working

- [ ] Poison pill handling: malformed messages go to DLQ, worker keeps running
- [ ] Worker `GET /health` shows non-zero `dlq_depth` after poison pills are injected
- [ ] Worker status remains `healthy` while DLQ fills
- [ ] System handles failure scenarios gracefully (no dangling state, no crash loops)
- [ ] All services/workers required for team size are implemented

---

## What Is Not Working / Cut

---

## Poison Pill Demonstration

How to inject a poison pill:

```bash
# Malformed (missing hash)
docker compose exec holmes redis-cli -h redis PUBLISH transcode-complete '{\"originalFileName\":\"demo.mp4\",\"contentType\":\"video/mp4\",\"fileSizeBytes\":1000000,\"uploadedBy\":\"user-123\",\"duration\":42,\"status\":\"complete\",\"updatedAt\":\"2026-04-27T19:16:00.000Z\"}'
```

Moderation Worker health before injection:

```bash
docker compose exec holmes bash
curl -s "http://moderation-worker:3007/health"
```

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok",
  "numJobsCompleted": 0,
  "lastJobInfo": "no completed jobs",
  "dlqLength": 0
}
```

Worker health after injection:

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok",
  "numJobsCompleted": 0,
  "lastJobInfo": "no completed jobs",
  "dlqLength": 1
}
```

---

## k6 Results: Poison Pill Resilience (`k6/sprint-3-poison.js`)

```

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: /workspace/k6/sprint-3-poison.js
        output: -

     scenarios: (100.00%) 1 scenario, 20 max VUs, 1m40s max duration (incl. graceful stop):
              * default: Up to 20 looping VUs for 1m10s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)

INFO[0000] initial worker health: {"status":"healthy","queue_depth":0,"dlq_depth":0,"last_job_at":null}  source=console
INFO[0070] final worker health: {"status":"healthy","queue_depth":1791,"dlq_depth":450,"dlq_depth_before_test":0,"last_job_at":"2026-04-29T22:41:26.194Z"}  source=console


  █ THRESHOLDS 

    checks
    ✓ 'rate>0.90' rate=100.00%

    dlq_observed_after_poison_rate
    ✓ 'rate>0' rate=98.97%

    http_req_duration
    ✓ 'p(95)<2000' p(95)=127.39ms

    http_req_failed
    ✓ 'rate<0.15' rate=4.59%

    redis_poison_injection_success_rate
    ✓ 'rate>0.95' rate=100.00%

    valid_after_poison_success_rate
    ✓ 'rate>0.90' rate=100.00%

    valid_upload_success_rate
    ✓ 'rate>0.95' rate=100.00%

    worker_health_healthy_rate
    ✓ 'rate>0.95' rate=100.00%


  █ TOTAL RESULTS 

    checks_total.......: 4469    59.955494/s
    checks_succeeded...: 100.00% 4469 out of 4469
    checks_failed......: 0.00%   0 out of 4469

    ✓ transcode worker health endpoint is healthy
    ✓ valid upload accepted
    ✓ valid upload has upload object
    ✓ worker poison [worker_empty_body] pushed to transcode queue
    ✓ worker poison [worker_invalid_json] pushed to transcode queue
    ✓ edge poison [upload_missing_fileHash] rejected
    ✓ worker poison [worker_zero_duration] pushed to transcode queue
    ✓ worker poison [worker_missing_duration] pushed to transcode queue
    ✓ edge poison [upload_invalid_json] rejected
    ✓ worker poison [worker_missing_fileHash] pushed to transcode queue
    ✓ edge poison [upload_invalid_fileSizeBytes] rejected
    ✓ final worker status is healthy
    ✓ final worker dlq_depth is non-zero
    ✓ final worker dlq_depth increased during test

    CUSTOM
    dlq_observed_after_poison_rate........: 98.97%  194 out of 196
    edge_poison_rejected..................: 99      1.32817/s
    redis_poison_injection_success_rate...: 100.00% 450 out of 450
    uploads_accepted......................: 1860    24.953506/s
    valid_after_poison_success_rate.......: 100.00% 450 out of 450
    valid_upload_success_rate.............: 100.00% 1860 out of 1860
    worker_health_healthy_rate............: 100.00% 197 out of 197
    worker_poison_pills_injected..........: 450     6.037139/s

    HTTP
    http_req_duration.....................: avg=39.05ms  min=506.01µs med=24.23ms  max=2.07s    p(50)=24.23ms  p(95)=127.39ms p(99)=240.72ms
      { expected_response:true }..........: avg=40.83ms  min=1.29ms   med=25.24ms  max=2.07s    p(50)=25.24ms  p(95)=134.19ms p(99)=243.65ms
    http_req_failed.......................: 4.59%   99 out of 2156
    http_reqs.............................: 2156    28.924602/s

    EXECUTION
    iteration_duration....................: avg=543.63ms min=509.9ms  med=528.97ms max=783.25ms p(50)=528.97ms p(95)=636.97ms p(99)=729.35ms
    iterations............................: 1860    24.953506/s
    vus...................................: 1       min=1            max=20
    vus_max...............................: 20      min=20           max=20

    NETWORK
    data_received.........................: 2.5 MB  34 kB/s
    data_sent.............................: 795 kB  11 kB/s




running (1m14.5s), 00/20 VUs, 1860 complete and 0 interrupted iterations
default ✓ [======================================] 00/20 VUs  1m10s

```
The throughput held, and the worker stayed healthy throughout as indicated by the healthchecks being successful throughout the test.

---

## Blockers and Lessons Learned

This group is very large, and this project was clearly not designed for a group of our size. Distributing work is difficult, and many of these parts are interconnected. Even when designating tasks, there ultimately wasn’t much people could do outside of working on the three workers, and splitting this in a way that didn’t involve pair-programming was impossible.