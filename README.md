# Team 6 - Video Processing Pipeline 

**Course:** COMPSCI 426  
**Team:** Anne-Colombe Sinkpon, Duyen Tran, Zoë Akpan, Jihyun Kim, Nishil Adina, Gabriella Wang, Jahnavi Sharma  
**System:** Video Processing Pipeline  
**Repository:** GitHub URL — public fork of https://github.com/umass-cs-426/starter-project --> Group repo = https://github.com/ZoeAkpan/team-6-video-processing 

![flowchart](flowchart.png)

## Team and Service Ownership

| Team Member | Services / Components Owned                             |
| ----------- | ------------------------------------------------------  |
|  Anne-Colombe Sinkpon | [`upload-service/`, `thumbnail-worker`]       |
|  Duyen Tran           | [`catalog-service`]                           |
|  Zoë Akpan            | [`upload-service`, `thumbnail-worker`(can help out)]|
|  Jihyun Kim           | [`quota-service`]                             |
|  Nishil Adina         | [`moderation-worker`, `playback-service`]     |
|  Gabriella Wang       | [`search-index-worker`]                       |
|  Jahnavi Sharma       | [`catalog-service` ]                          |
|  Robert Winfield      | [`transcode-worker`]                          |
|  Sebastian Vaskes Pimentel | [`playback-service`]                     |


> Ownership is verified by `git log --author`. Each person must have meaningful commits in the directories they claim.

---

## How to Start the System

```bash
# Start everything (builds images on first run)
docker compose up --build

# Start with service replicas (Sprint 4)
docker compose up --scale your-service=3

# Verify all services are healthy
docker compose ps

# Stream logs
docker compose logs -f

# Open a shell in the holmes investigation container
docker compose exec holmes bash
```

### Base URLs (development)
| Service/Worker | Port |
|-------------------------|-----------------------|
| `upload-service`        | http://localhost:3000 |
| `quota-service`         | http://localhost:3001 |
| `catalog-service`       | http://localhost:3002 |
| `playback-service`      | http://localhost:3003 |
| `transcode-worker`      | http://localhost:3004 |
| `thumbnail-worker`      | http://localhost:3005 |
| `search-index-worker`   | http://localhost:3006 |
| `moderation-worker`     | http://localhost:3007 |
| `holmes`                | (no port — access via exec) |


> From inside holmes, services are reachable by name:
> `curl http://your-service:3000/health`
>
> See [holmes/README.md](holmes/README.md) for a full tool reference.

---

## System Overview

This project is a video processing pipeline made up of small services connected through Docker Compose. In Sprint 1, the main flow we have working is that a user sends an upload request to `upload-service`, and `upload-service` makes a synchronous HTTP call to `quota-service` to make sure the user is still within their upload limits. If the quota check passes, the upload record is saved in the upload database. We also have `catalog-service`, which reads video records from its own database and exposes a read endpoint for the current catalog. Redis is also running in the system and is used by services for health checks and quota-related state.

---

## API Reference

<!--
  Document every endpoint for every service.
  Follow the format described in the project documentation: compact code block notation, then an example curl and an example response. Add a level-2 heading per service, level-3 per endpoint.
-->

## catalog-service

### GET /health

```
GET /health

  Returns the health status of the catalog service and its database.

  Responses:
    200  Service healthy
    503  Database unreachable
```

**Example request:**

```bash
curl http://localhost:3002/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "db": "ok"
}
```

**Example response (503):**

```json
{
  "status": "unhealthy",
  "db": "error: connection refused"
}
```

---

### GET /videos

```
GET /videos

  Returns video records with status = available ordered by newest first.

  Responses:
    200  JSON array of videos
    500  Database query error
```

**Example request:**

```bash
curl http://localhost:3002/videos
```

**Example response (200):**

```json
[
  {
    "id": "video-id",
    "upload_id": "upload-id",
    "user_id": "user-123",
    "title": "Demo Video",
    "original_filename": "demo.mp4",
    "duration_seconds": 42,
    "status": "available"
  }
]
```
> Results are cached in Redis for 60 seconds (`catalog:videos:available`). Cache is invalidated automatically when a video is marked unavailable via the `video.rejected` pub/sub event.
---

## upload-service

### GET /health

**Method and path:** `GET /health`

**Description:** Returns the health status of the upload service, PostgreSQL,
and Redis.

**Responses:**

| Status | Meaning |
| ------ | ------- |
| 200 | Service and dependencies healthy |
| 503 | One or more dependencies unreachable |

**Example request:**

```bash
curl http://localhost:3000/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "upload-service",
  "timestamp": "2026-04-27T18:21:00.000Z",
  "uptime_seconds": 42,
  "checks": {
    "database": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### POST /upload

**Method and path:** `POST /upload`

**Description:** Sends an upload request to the upload service. The endpoint is
idempotent by `fileHash`: if the hash already exists, the existing upload is
returned. New uploads synchronously call `quota-service` at `POST /quota/check`;
if quota allows the upload, the service writes the upload record and pushes a
job to the Redis `transcode-jobs` queue.

**Request body:**

| Field | Type | Required | Meaning |
| ----- | ---- | -------- | ------- |
| `originalFilename` | string | required | Original uploaded file name |
| `contentType` | string | required | MIME type for the file, such as `video/mp4` |
| `fileSizeBytes` | number | required | File size in bytes; must be greater than `0` |
| `uploadedBy` | string | required | User or account identifier for the uploader |
| `fileHash` | string | required | Hash used for idempotency and duplicate detection |
| `metadata` | object | optional | Extra upload metadata; defaults to `{}` |

**Responses:**

| Status | Meaning |
| ------ | ------- |
| 201 | Upload accepted and saved |
| 200 | Matching `fileHash` already exists; existing upload returned |
| 400 | Missing or invalid request body fields |
| 403 | Upload blocked by quota service |
| 500 | Internal error |

**Example request:**

```bash
curl -X POST http://localhost:3000/upload \
  -H "Content-Type: application/json" \
  -d '{
    "originalFilename": "demo.mp4",
    "contentType": "video/mp4",
    "fileSizeBytes": 1000000,
    "uploadedBy": "user-123",
    "fileHash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "metadata": { "title": "Demo", "duration": "1" }
  }'
```

**Example response (201):**

```json
{
  "message": "Upload accepted",
  "upload": {
    "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "original_filename": "demo.mp4",
    "storage_key": "uploads/1777314060000-demo.mp4",
    "file_hash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "content_type": "video/mp4",
    "file_size_bytes": "1000000",
    "uploaded_by": "user-123",
    "status": "pending",
    "error_message": null,
    "metadata": { "title": "Demo", "duration": "1" },
    "created_at": "2026-04-27T18:21:00.000Z",
    "updated_at": "2026-04-27T18:21:00.000Z",
    "processing_started_at": null,
    "processing_completed_at": null
  },
  "quota": {
    "allowed": true,
    "reason": "ok",
    "userId": "user-123",
    "requestedFileSizeBytes": 1000000,
    "uploadCount": 0,
    "uploadLimitCount": 10,
    "remainingUploadSlots": 10,
    "storageUsedBytes": 0,
    "storageLimitBytes": 1073741824,
    "remainingBytes": 1073741824
  }
}
```

**Example response (200, duplicate fileHash):**

```json
{
  "message": "Upload already exists",
  "idempotent": true,
  "upload": {
    "id": "7a8c9d4f-7648-4f8f-94f0-4455347aa101",
    "original_filename": "demo.mp4",
    "storage_key": "uploads/1777314060000-demo.mp4",
    "file_hash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "content_type": "video/mp4",
    "file_size_bytes": "1000000",
    "uploaded_by": "user-123",
    "status": "pending",
    "error_message": null,
    "metadata": { "title": "Demo", "duration": "1" },
    "created_at": "2026-04-27T18:21:00.000Z",
    "updated_at": "2026-04-27T18:21:00.000Z",
    "processing_started_at": null,
    "processing_completed_at": null
  }
}
```

---

## quota-service

### GET /health

```
GET /health

  Returns the health status of the quota service, PostgreSQL, and Redis.

  Responses:
    200  Service and dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://localhost:3001/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok"
}
```

### POST /quota/check

```
POST /quota/check

  Sends information regarding an upload request (user id and file size) to the quota service. The quota service determines if this upload should be accepted or rejected based on the user's quota limits.

  Responses:
    200  Quota check completed
    400  Missing or invalid request body fields
    500  Internal error
```

**Example request:**

```bash
curl -X POST http://localhost:3001/quota/check \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "fileSizeBytes": 1000000
  }'
```

**Example response (200):**

```json
{
  "allowed": true,
  "reason": "ok",
  "userId": "user-123",
  "requestedFileSizeBytes": 1000000,
  "uploadCount": 1,
  "uploadLimitCount": 10,
  "remainingUploadSlots": 9,
  "storageUsedBytes": 1000000,
  "storageLimitBytes": 1073741824,
  "remainingBytes": 1072741824,
}
```

## playback-service
 
### GET /health
 
```
GET /health
 
  Returns the health status of the playback service, PostgreSQL, and Redis.
 
  Responses:
    200  Service and dependencies healthy
    503  One or more dependencies unreachable
```
 
**Example request:**
 
```bash
curl http://localhost:3003/health
```
 
**Example response (200):**
 
```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok"
}
```
 
**Example response (503):**
 
```json
{
  "status": "unhealthy",
  "db": "ok",
  "redis": "error: connection refused"
}
```
 
---
 
### POST /views
 
```
POST /views
 
  Records a view event for a user at a given playback position. Duplicate
  events for the same user and video within a 30-second window are ignored
  and the existing record is returned. On success, a view event is published
  to Redis on the view-started channel.
 
  Responses:
    200  Duplicate event within 30-second window; ignored
    201  View event recorded
    400  Missing or invalid request body fields
    500  Internal error
```
 
**Example request:**
 
```bash
curl -X POST http://localhost:3003/views \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "videoId": "video-456",
    "positionSeconds": 42
  }'
```
 
**Example response (201):**
 
```json
{
  "duplicate": false,
  "ignored": false,
  "id": "a1b2c3d4-...",
  "userId": "user-123",
  "videoId": "video-456",
  "positionSeconds": 42,
  "viewedAt": "2026-04-20T12:00:00.000Z"
}
```
 
**Example response (200 — duplicate):**
 
```json
{
  "duplicate": true,
  "ignored": true,
  "userId": "user-123",
  "videoId": "video-456",
  "positionSeconds": 42,
  "viewedAt": "2026-04-20T11:59:45.000Z"
}
```
 
---
 
### GET /resume
 
```
GET /resume
 
  Returns the most recent playback position for a given user and video,
  allowing clients to resume from where the user left off.
 
  Query parameters:
    userId   string  required
    videoId  string  required
 
  Responses:
    200  Resume position found
    400  Missing required query parameters
    404  No view history found for this user and video
    500  Internal error
```
 
**Example request:**
 
```bash
curl "http://localhost:3003/resume?userId=user-123&videoId=video-456"
```
 
**Example response (200):**
 
```json
{
  "userId": "user-123",
  "videoId": "video-456",
  "positionSeconds": 42,
  "viewedAt": "2026-04-20T12:00:00.000Z"
}
```
 
**Example response (404):**
 
```json
{
  "error": "resume position not found",
  "userId": "user-123",
  "videoId": "video-456"
}
```

## thumbnail-worker

### GET /health

**Method and path:** `GET /health`

**Description:** Returns the health status of the thumbnail worker, PostgreSQL,
Redis, queue depth, dead letter queue depth, and the timestamp of the last
successfully processed thumbnail job. The worker listens for `transcode-complete`
Redis pub/sub events, validates the event payload, enqueues valid messages onto
`thumbnail-jobs`, writes simulated thumbnail references to the catalog database,
clears the catalog cache, and publishes `thumbnail.complete` after successful
processing.

Malformed messages and messages that reference a missing catalog video are
treated as poison pills and moved to `thumbnail-dead-letter`. 

**Responses:**

| Status | Meaning |
| ------ | ------- |
| 200 | Worker and dependencies healthy |
| 503 | PostgreSQL or Redis unhealthy |

**Example request:**

```bash
curl http://localhost:3005/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok",
  "queueDepth": 0,
  "deadLetterQueueDepth": 3,
  "lastSuccessfullyProcessedJobAt": "2026-04-27T18:20:00.000Z",
  "inFlightJobId": null,
  "subscribedChannels": ["transcode-complete"],
  "timestamp": "2026-04-27T18:21:00.000Z"
}
```

## moderation-worker

### GET /health

```
GET /health

  Returns the health status of this worker and its dependencies.

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://localhost:3007/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok",
  "numJobsCompleted": 1,
  "lastJobInfo": {
    "fileHash": "abc123",
    "completedAt": "2026-04-28T03:15:59.745Z",
    "moderationResult": "approved"
  },
  "dlqLength": 0
}
```

### GET /dlq

```
GET /dlq

  Returns the current contents of the moderation worker's dead-letter queue.
  Items are added to the DLQ when a received transcode-complete message has
  an invalid or malformed payload.

  Responses:
    200  DLQ contents returned successfully
    500  Internal error
```

**Example request:**

```bash
curl http://localhost:3007/dlq
```

**Example response (200 — with items):**

```json
{
  "queue": "moderation-worker:dlq",
  "length": 1,
  "items": [
    {
      "index": 0,
      "entry": {
        "error": "Missing field: fileHash",
        "raw": "{\"originalFileName\":\"demo.mp4\",\"contentType\":\"video/mp4\",\"fileSizeBytes\":1000000,\"uploadedBy\":\"user-123\",\"duration\":42,\"status\":\"complete\",\"updatedAt\":\"2026-04-27T19:16:00.000Z\"}"
      }
    }
  ]
}
```

**Example response (200 — empty):**

```json
{
  "queue": "moderation-worker:dlq",
  "length": 0,
  "items": []
}
```

## Sprint History

| Sprint | Tag        | Plan                                              | Report                                    |
| ------ | ---------- | ------------------------------------------------- | ----------------------------------------- |
| 1      | `sprint-1` | [SPRINT-1-PLAN.md](sprint-plans/SPRINT-1-PLAN.md) | [SPRINT-1.md](sprint-reports/SPRINT-1.md) |
| 2      | `sprint-2` | [SPRINT-2-PLAN.md](sprint-plans/SPRINT-2-PLAN.md) | [SPRINT-2.md](sprint-reports/SPRINT-2.md) |
| 3      | `sprint-3` | [SPRINT-3-PLAN.md](sprint-plans/SPRINT-3-PLAN.md) | [SPRINT-3.md](sprint-reports/SPRINT-3.md) |
| 4      | `sprint-4` | [SPRINT-4-PLAN.md](sprint-plans/SPRINT-4-PLAN.md) | [SPRINT-4.md](sprint-reports/SPRINT-4.md) |
