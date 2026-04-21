# Sprint 2 Plan — Team 6


**Sprint:** 2 — Async Pipelines and Caching  
**Dates:** 04.14 → 04.21  
**Written:** 04.14 in class


---


## Goal


[What will your team have working by end of sprint? Name the specific cache, queue, and worker you are adding.]


Our team will be striving to complete the Redis cache, async pipeline, idempotent write path, worker health endpoints, and 2 k6 tests by the end of this sprint. Outside of technical functions, we will complete/update the README and sprint report. This is an ambitious goal, so if we do not have time to complete everything, we should drop 1 test for this sprint and complete it during the next sprint. 


---


## Ownership


| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| Anne-Colombe Sinkpon      | `upload/`, `thumbnail-worker`  |
| Duyen Tran      | `catalog-service` |
| Zoë Akpan      | `upload/` |
| Gabriella Wang      | `search-index-worker` |
| Jihyun Kim      | `quota-service/`, `quota-service/db/` |
| Jahnavi Sharma      | `catalog-service/` |
| Robert Winfield    | `transcode-worker/`, `moderation-worker` |
| Nishil Adina | `playback-service/`, `moderation-worker` | 
---


## Tasks


### [Anne-Colombe Sinkpon]


- [ ] upload service pushes a job onto the Redis transcode queue
- [ ] thumbnail worker exposes a GET /health endpoint that includes the current queue depth, the dead letter queue depth, and the timestamp of the last successfully processed job.
- [ ] make thumbnail Worker extract thumbnails
- [ ] make the thumbnail worker write thumbnail references to the catalog database.


### [Duyen Tran]


- [ ] Implement get/videos/:id with Redis caching
- [ ] Idempotent write paths through unique constraints on upload_id
- [ ] Implement `GET /video/search` - search endpoint querying catalog DB by title/metadata


### [Zoë Akpan]


- [ ] Upload service - return existing record if hash already exists
- [ ] Upload service - call quota service synchronously; reject the upload if the quota has been exceeded
- [ ] Write a K6 test to see how the system performs under traffic
- [ ] Complete sprint plan 




### [Gabriella Wang]


- [ ] Implement database connection to search DB
- [ ] Validate incoming messages and required metadata and write into search database 
- [ ] Add logging for successful indexing


### [Jahnavi Sharma]


- [ ] Implement `GET /videos` browse endpoint with Redis cache support
- [ ] Handle “video rejected” pub/sub event from Moderation Worker - mark video as unavailable in catalog DB
- [ ] Update catalog-service README with new endpoint documentation


### [Jihyun Kim]


- [ ] Design the quota-service database tables
- [ ] Implement `POST /quota/check` for upload validation
- [ ] Define the request/response format between upload-service and quota-service
- [ ] Implement `GET /health` and Docker healthchecks


### [Robert Winfield]


- [ ] Integrate transcode-worker queue with upload-service queue
- [ ] Implement health endpoint for transcode-worker
- [ ] Update format of video job to match upload-service job


### [Nishil Adina]


- [ ] Review idempotency checks and Redis pub/sub usage in playback-service
- [ ] Handle Redis pub/sub events in moderation worker
- [ ] Add logging to moderation worker
---


## Risks
Similarly to sprint 1, we might not have enough time to finish all of the tasks we set out to do for sprint 2 before the due date. The project site was also down for several days with no announcements, so we risk running into this issue again. It was especially irritating that it was during the weekend when people are free to work. One person had to complete a lot of the work very late at night due to this. We plan to distribute tasks better this sprint and complete our own work. 
---


## Definition of Done


A TA can trigger an action, watch the queue flow in Docker Compose logs, hit the worker's `/health` to see queue depth and last-job-at, and review k6 results showing the caching improvement.
