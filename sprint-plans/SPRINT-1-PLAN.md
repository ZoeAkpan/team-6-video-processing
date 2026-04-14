# Sprint 1 Plan — [Team 6]

**Sprint:** 1 — Foundation 
**Dates:** 04.07 → 04.14 
**Written:** 04.07 in class



---



## Goal


Our goal is to get the very basic structure of the project finished, which includes the yml file, connections to the Postgres database, a few endpoints, the sprint 1 plan, the sprint report, and a K6 test for managing traffic. We are just aiming to get a small portion of the project running. 


---



## Ownership



| Team Member | Files / Directories Owned This Sprint           |
| ----------- | ----------------------------------------------- |
| [Anne-Colombe Sinkpon]      | `upload/`, `upload/db/schema.sql` |
| [Jahnavi Sharma]      | `[catalog-service]/`, `catalog-service/Dockerfile`, `catalog-service/index.js`, `catalog-service/package.json`|
| [Nishil Adina]      | `quota-service/`, `k6/sprint-1.js`               |
| [Zoë Akpan]     | `upload/`, `upload/db/schema.sql`, `README.md`               |
| [Robert Winfield]     | `[transcode-worker]/`               |
| [Duyen Tran]     | `[catalog-service]/`, `catalog-service/db/schema.sql`, `compose.yml` additions     |
| [Gabriella Wang]     | `[search-index-worker]/’        |
| [Jihyun Kim]     | `quota-service/`, `quota-service/db/schema.sql`, `compose.yml` additions |


Each person must have meaningful commits in the paths they claim. Ownership is verified by:



```bash
git log --author="Name" --oneline -- path/to/directory/
```



---



## Tasks


### [Anne-Colombe Sinkpon]

- [ ] Implement `GET /health` with DB check
- [ ] Write `upload/db/schema.sql` and seed script
- [ ] Set up `upload/` with Express + Postgres connection
- [ ] Add `healthcheck` directive to `compose.yml`


### [Jahnavi Sharma]

- [ ] Set up `[service]/` with Express + Redis connection
- [ ] Implement `GET /health` with Redis check
- [ ] Implement `GET /[resource]` — stub returning placeholder data
- [ ] Test synchronous call to [other service]


### [Nishil Adina]

- [ ] Create `quota-service/` directory for quota service
- [ ] Create quota DB
- [ ] Run k6 load testing


### [Gabriella Wang]

- [ ] Set up `search index worker`
- [ ] Establish Redis pub/sub connection 
- [ ] Implement a listener for `transcode complete event


### [Zoë Akpan]

- [ ] Write `README.md` startup instructions and endpoint list
- [ ] Collectively write `sprint-plans/SPRINT-1-PLAN.md`
- [ ] Implement K6 baseline test for reading traffic to viewing the video catalog endpoint
- [ ] Implement `GET /health` with Redis check


### [Robert Winfield]

- [ ] Set up `transcode-worker/` directory for Redis queue
- [ ] Implement logic for consuming job from queue
- [ ] Write Redis benchmark tests for load testing


### [Duyen Tran]

- [ ] Create `[catalog-service]/` with Redis
- [ ] Create catalog DB
- [ ] Implement `Get /health]/` with Redis


### [Jihyun Kim]

- [ ] Create `quota-service/db/schema.sql`
- [ ] Implement `GET /health` with Postgres and Redis checks
- [ ] Implement `POST /quota/check` for synchronous validation from Upload Service
- [ ] Add `quota-service` and `quota-db` to `compose.yml` with healthchecks and `depends_on`



---


## Risks


This is a pretty large team, so I’m almost certain we are going to run into bad merge conflicts. Some of our parts depend on other team members finishing their task, so there is also that concern. If a task takes longer than expected, we value open communication, so team members can help each other and work on the task together. 


---



## Definition of Done



A TA can clone this repo, check out `sprint-1`, run `docker compose up`, and:



- `docker compose ps` shows every service as `(healthy)`
- `GET /health` on each service returns `200` with DB and Redis status
- The synchronous service-to-service call works end-to-end
- k6 baseline results are included in `SPRINT-1.md`