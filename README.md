# Team 6 - Video Processing Pipeline 

**Course:** COMPSCI 426  
**Team:** Anne-Colombe Sinkpon, Duyen Tran, Zoë Akpan, Jihyun Kim, Nishil Adina, Gabriella Wang, Jahnavi Sharma
**System:** Video Processing Pipeline
**Repository:** [GitHub URL — public fork of https://github.com/umass-cs-426/starter-project] --> Group repo = https://github.com/ZoeAkpan/team-6-video-processing

---

## Team and Service Ownership

| Team Member | Services / Components Owned                             |
| ----------- | ------------------------------------------------------  |
|  Anne-Colombe Sinkpon | [`upload-service/`, `thumbnail-worker`]       |
|  Duyen Tran           | [`catalog-service`]                           |
|  Zoë Akpan            | [`upload-service`, `thumbnail-worker`(can help out)]|
|  Jihyun Kim           | [`quota-service`]                             |
|  Nishil Adina         | [`quota-service`, `playback-service`]         |
|  Gabriella Wang       | [`search-index-worker`]                       |
|  Jahnavi Sharma       | [`catalog-service` ]                          |
|  Robert Winfield      | [`transcode-worker`, `moderation-worker`]     |
|  Sebastian Vaskes Pimentel | [`playback-service`, `moderation-worker`]|


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
`upload-service`        http://localhost:3000
`quota-service`         http://localhost:3001
`catalog-service`       http://localhost:3002
`playback-service`      http://localhost:3003
`transcode-worker`      http://localhost:3004
`thumbnail-worker`      http://localhost:3005
`search-index-worker`   http://localhost:3006
`moderation-worker`     http://localhost:3007
`holmes`                (no port — access via exec)


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

---

### catalog-service

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
curl http://localhost:3000/health
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
curl http://localhost:3000/videos
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

---

### upload-service

### GET /health

```
GET /health

  Returns the health status of the upload service, PostgreSQL, and Redis.

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
  "service": "upload-service",
  "checks": {
    "database": { "status": "healthy" },
    "redis": { "status": "healthy" }
  }
}
```

---

### POST /upload

```
POST /upload

  Sends an upload request to the upload service. The service first makes a
  synchronous HTTP call to quota-service at POST /quota/check. If the quota
  check passes, the upload record is inserted into the upload database.

  Responses:
    201  Upload accepted and saved
    400  Missing or invalid request body fields
    403  Upload blocked by quota service
    500  Internal error
```

**Example request:**

```bash
curl -X POST http://localhost:3001/upload \
  -H "Content-Type: application/json" \
  -d '{
    "originalFilename": "demo.mp4",
    "contentType": "video/mp4",
    "fileSizeBytes": 1000000,
    "uploadedBy": "user-123",
    "metadata": { "title": "Demo" }
  }'
```

**Example response (201):**

```json
{
  "message": "Upload accepted",
  "upload": {
    "original_filename": "demo.mp4",
    "status": "pending"
  },
  "quota": {
    "allowed": true,
    "reason": "ok"
  }
}
```

---

### quota-service

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
curl http://localhost:3004/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "db": "ok",
  "redis": "ok"
}
```

---

### Quota Service

GET /health

```
GET /health

  Returns the health status of this service and its dependencies.

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

Example request:

```bash
curl http://localhost:3004/health
```

### Playback Service

GET /health

This service provides video playback-related APIs. If not running in compose, the health endpoint may be unreachable during local demos.

Example request:

```bash
curl http://localhost:3000/health
```

### Moderation Worker

GET /health

```
GET /health

  Returns the health status of this worker and its dependencies.

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

Example request:

```bash
curl http://localhost:3006/health
```


<!-- Add the rest of your endpoints below. One ### section per endpoint. -->
### POST /quota/check

```
POST /quota/check

  Checks whether a user is still allowed to upload a file based on upload count
  and storage limits.

  Responses:
    200  Quota check completed
    400  Missing or invalid request body fields
    500  Internal error
```

**Example request:**

```bash
curl -X POST http://localhost:3004/quota/check \
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
  "uploadCount": 0,
  "uploadLimitCount": 10,
  "remainingUploadSlots": 10,
  "storageUsedBytes": 0,
  "storageLimitBytes": 1073741824,
  "remainingBytes": 1073741824
}
```

---

## Sprint History

| Sprint | Tag        | Plan                                              | Report                                    |
| ------ | ---------- | ------------------------------------------------- | ----------------------------------------- |
| 1      | `sprint-1` | [SPRINT-1-PLAN.md](sprint-plans/SPRINT-1-PLAN.md) | [SPRINT-1.md](sprint-reports/SPRINT-1.md) |
| 2      | `sprint-2` | [SPRINT-2-PLAN.md](sprint-plans/SPRINT-2-PLAN.md) | [SPRINT-2.md](sprint-reports/SPRINT-2.md) |
| 3      | `sprint-3` | [SPRINT-3-PLAN.md](sprint-plans/SPRINT-3-PLAN.md) | [SPRINT-3.md](sprint-reports/SPRINT-3.md) |
| 4      | `sprint-4` | [SPRINT-4-PLAN.md](sprint-plans/SPRINT-4-PLAN.md) | [SPRINT-4.md](sprint-reports/SPRINT-4.md) |
