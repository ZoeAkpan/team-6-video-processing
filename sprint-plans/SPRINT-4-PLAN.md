# Sprint 4 Plan — Team 6 

**Sprint:** 4 — Replication, Scaling, and Polish  
**Dates:** 04.28 → 05.07  
**Written:** 04.28 in class

---

## Goal

We need to replicate at least three services, so we’ve chosen to replicate the catalog, upload, and quota services. 
```
docker compose up -d --build --scale upload-service=3 --scale quota-service=3 --scale catalog-service=3 
```
Caddy will handle load balancing between the replicas. We are planning to clean up the code by strengthening variable names, organizing and adding information to the README.md, removing unnecessary code, and testing to ensure all workers/services work. 

---

## Ownership

| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| [Anne-Colombe Sinkpon]      | `/upload-service`, `/thumbnail-worker` |
| [Duyen Tran]      | `catalog-service` |
| [Gabriella Wang]      | `search-index-worker` |
| [Jihyun Kim]      | `quota-service/` |
| [Zoë Akpan] | `upload-service` | 
| [Nishil Adina] | `moderation-worker/`, `README.md` |

---

## Tasks

### [Anne-Colombe Sinkpon]

- [ ] add load balancer service for upload traffic
- [ ] add replica-identifying logs to upload-service
- [ ] clean up upload service and thumbnail worker by improving var names
- [ ] change up code if necessary to match project requirements

### [Duyen Tran]

- [ ] Add Caddy in front of catalog-service
- [ ] Update compose.yml for scaling
- [ ] Update README.md for scaling
- [ ] Polish catalog-service/index.js 

### [Zoë Akpan]

- [ ] Add Caddy for quota service as a load balancer (scale this)
- [ ] Remove any commented out code
- [ ] Remove any random comments or unhelpful logging 

### [Gabriella Wang]

- [ ] Update README.md with search-index-worker health endpoint
- [ ] Test and debug worker pipeline to ensure smooth bridge from transcode-worker to search-index-worker

### Jihyun Kim

- [ ] Verify `quota-service` is stateless and safe for replication: all quota state lives in Postgres/Redis and no in-memory state affects correctness across replicas
- [ ] Validate `POST /quota/check`, `POST /quota/consume`, and `POST /quota/release` under concurrent requests so duplicate uploads do not double-consume quota
- [ ] Test the replicated upload path against shared quota state and confirm quota counts/storage usage remain correct when multiple replicas are running
- [ ] Update any quota-related `compose.yml` settings, environment variables, and healthchecks needed for replication/scaling

### [Robert Winfield]

- [ ] ~~Add Caddy load balancing for transcode-worker~~
- [ ] Update README.md to describe scaling capabilities
- [ ] Strengthen testing for transcode module

### [Nishil Adina]
- [ ] Polish code in moderation-worker
- [ ] Ensure all endpoints across the system are documented in README.md
- [ ] Add seed data for demo purposes (endpoint in upload-service?)

---

## Risks

Since this is the last sprint we are going to do, there might not be enough time to finish everything, including polishing up the code and making sure it looks nice for the presentation. 

## Definition of Done

`docker compose up -d --build --scale upload-service=3 --scale quota-service=3 --scale catalog-service=3` starts successfully. `docker compose ps` shows all replicas as `(healthy)`. k6 scaling comparison shows measurable improvement. Replica failure test shows no dropped requests.

