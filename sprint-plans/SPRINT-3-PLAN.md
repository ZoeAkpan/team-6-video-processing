# Sprint 3 Plan — [Team 6]

**Sprint:** 3 — Reliability and Poison Pills  
**Dates:** 04.21 → 04.28  
**Written:** 04.21 in class

---

## Goal

Poison pill handling will improve our system by allowing workers to gracefully acknowledge malformed requests while continuing to process proper requests. Malformed requests will be added to a dead letter queue, allowing for us to carefully monitor the system and track malformed data. Multiple queues will get DLQ handling: transcode-worker will look for poison pills on the transcode queue, and workers that monitor the “transcode-complete” Redis pub/sub channel (moderation-worker, thumbnail-worker, search-index-worker) will handle poison pills as well.  

---

## Ownership

| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| [Jahnavi Sharma]      | `[catalog-service]` |
| [Duyen Tran]      | `[catalog-service]` |
| [Jihyun Kim]      | `[quota-service/]` |
| [Gabriella Wang]      | `[search-index-worker/]` |
| [Anne-Colombe Sinkpon]      | `[thumbnail-worker/]` |
| Zoë Akpan | [`transcode-worker\`, ` upload-service`, `catalog-service` ] |
| Nishil Adina | `moderation-worker/`, `playback-service/` |
| Robert Winfield | `transcode-worker/` |
---

## Tasks

### [Jahnavi Sharma]

- [ ] Add dead letter queue handling for video.rejected pub/sub: if processing a rejection event fails (malformed message, DB error), log the failed message to a catalog:dlq Redis list instead of silently dropping it
- [ ] Add retry logic to the video.rejected subscriber - retry up to 3(?) times with exponential backoff before sending to DLQ
- [ ] Expose DLQ depth in GET /health response so failures are visible during demos
- [ ] Add poison pill protection to the Redis cache - if a cached value fails to parse (corrupted JSON), delete the key and fall back to DB instead of returning a 500

### [Jihyun Kim]

- [ ] Harden `quota-service` for Sprint 3 reliability: verify `GET /health` checks Postgres and Redis correctly and that the container stays `(healthy)` in `docker compose ps`
- [ ] Finish Upload Service ↔ Quota Service integration so every upload request calls `POST /quota/check` before any transcode job is pushed to Redis
- [ ] Implement quota database updates for accepted uploads so per-user `upload_count` and `storage_used_bytes` stay correct
- [ ] Make quota handling idempotent so duplicate upload attempts do not double-count a user’s quota usage
- [ ] Handle quota failures gracefully: over-limit uploads return a clear denial response and do not enqueue transcode jobs

### [Duyen Tran]

- [ ] Subscribe to transcode_complete pub/sub and handle poison pills
- [ ] Add poison pill protection to /videos/:id Redis cache
- [ ] K6 poison pill test
- [ ] Add logging to the trancode_complete subscriber

### [Gabriella Wang]

- [ ] Run end to end testing from transcode worker to search index worker and fix subscription to transcode-complete Redis pub/sub
- [ ] Update DLQ handling, update to handle errors and ensure worker maintains healthy when receiving bad messages
- [ ] Add retries for database failures before moving onto the next message
- [ ] Update health check endpoint to show more information such as timestamp, services, and DLQ depth

### [Zoë Akpan]

- [ ] Ensure services are all doing database writes rather than returning a random JSON object (upload and catalog)
- [ ] DLQ handling for transcode worker, where every worker has dead letter queue handling, and processable messages are moved to the DLQ ← ok someone said this is finished, so I will likely just do the task after this
- [ ] DLQ handling for thumbnail worker
- [ ] Verify container stays healthy in Docker after receiving poison pills
- [ ] Collectively work on README

### [Anne-Colombe Sinkpon]

- [ ]  write a k6 poison pill test for the thumbnail pipeline.
- [ ] Add clearer error labels for common failures like malformed JSON.
- [ ] Add retry handling for temporary db failures before moving a message to dlq.
- [ ] Improve dlq handling in the thumbnail worker.

### [Nishil Adina]
- [ ] Add poison pill handling to moderation-worker
- [ ] Add DLQ to moderation-worker
- [ ] Update moderation-worker /health endpoint to show info about DLQ

### [Robert Winfield]
- [ ] Write tests for DLQ in transcode-worker
- [ ] Improve transcode-jobs failure scenarios

---

## Risks

Some of the services depend on other people, so when people don't start working on their part early, this could lead to some delays. Last sprint, we did a better job at distributing the workload, and so this time we are trying to keep that up. Communication is always one of the risks; if someone can’t do their part or struggles to finish up their tasks, they should let the team know. 

---

## Definition of Done

After injecting poison pills, the worker's `/health` shows non-zero `dlq_depth` while status remains `healthy`. Good messages keep flowing. k6 results show throughput does not collapse.

