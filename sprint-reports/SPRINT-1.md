# Sprint 1 Report — Team 6

**Sprint:** 1 — Foundation  
**Tag:** `sprint-1`  
**Submitted:** 04.14

---

## What We Built

For Sprint 1, we focused on getting the basic foundation of our video processing system working in Docker Compose. Right now, our Compose setup brings up Holmes, Redis, `upload-service`, `quota-service`, `catalog-service`, and the PostgreSQL containers for upload, quota, and catalog data. We also added health checks so the services wait for their dependencies before starting.

We have working endpoints for `GET /health` on the services, a working read endpoint at `GET /videos` on `catalog-service`, and a synchronous service-to-service call between `upload-service` and `quota-service`. In our flow, the upload service calls the quota service first to check whether a user is allowed to upload a file, and if that check passes, the upload record is saved in the upload database.

---

## Individual Contributions

| Team Member | What They Delivered                                     | Key Commits            |
| ----------- | ------------------------------------------------------- | ---------------------- |
| Anne-Colombe Sinkpon | Upload service setup, upload DB wiring, synchronous upload-to-quota call, Compose updates, and k6 baseline script | `8e03a68`, `a9892d1`, `a6f2d95`, `24d50a8` |
| Zoë Akpan      | Upload service GET /health endpoint, Updated compose.yml, Implemented package.json, Implemented Dockerfile, Completed README file (organized tasks/roles), Collectively worked on Sprint 1 plan    |  https://github.com/ZoeAkpan/team-6-video-processing/pull/4 |
| Jahnavi Sharma      | Set up catalog-service with Express + Postgres connection, implemented GET /health with DB check, implemented GET /videos returning video records ordered by newest first | `52e5be5` |
| Nishil Adina | Began quota service with /health endpoint, organized port assignments for workers and services, investigated issues with health checks for other services.| `4aa1044`, `181b8bf`, `c12331d` |
| Duyen Tran      |Updated compose.yml with catalog port, finished catalog-service db schema, updated index to align more with the new schema | `2ddf16f`, `3b14656`, `d58a09b` |
| Gabriella Wang | Laid foundation to establish connection to a configurable Redis server, added error handling for Redis connection issues, Laid foundation for processing of video metadata | `39adcc1`, `5867613`, `d9bfdcf` |
| Jihyun Kim | Quota service implementation, quota DB schema, `GET /health` with Postgres and Redis checks, synchronous `POST /quota/check` endpoint, and Docker Compose writing/documentation updates | `7db6768`, `6de1ce2`, `3ede0a0` |
| Robert Winfield | Implemented foundational transcode-worker to run a Redis worker listening for incoming transcode jobs, wrote basic load test to simulate incoming jobs | `8bb12cd`, `c777e32`, `0bf3427` | 
| Sebastian Vaskes Pimentel | Implemented the Postgres and Redis backed HTTP service which records views,returns resume position and ignores duplicate events. Secondly, Implemented the Postgres and Redis backed background worker that listens for transcode.complete, stores moderation results, records malformed events, and publishes rejections events. | `6491377`, `7cc555`, `ac56f96`, `853ca84`, `463f061`, `a5f38f3`, `c38be54`|

Verify with:

```bash
git log --author="Name" --oneline -- path/to/directory/
```

---

## What Is Working

- [ ] `docker compose up` starts all services without errors
- [ ] `docker compose ps` shows most services as `(healthy)`
- [ ] `GET /health` on every service returns `200` with DB and Redis status
- [ ] At least one synchronous service-to-service call works end-to-end
- [ ] k6 baseline test runs successfully

We completed all of the items above during Sprint 1 testing.

---

## What Is Not Working / Cut

Some of the worker-based parts are still incomplete. Sprint 1 was mostly about getting the base services, databases, health endpoints, and one synchronous call working first. We also spent more time than expected on merge conflicts and getting everyone’s Docker Compose changes to work together. There are also some lingering issues with catalog-service and upload-service appearing as “unhealthy” when we run `docker compose ps` despite the services running and their health endpoints working.

---

## k6 Baseline Results

Script: `k6/sprint-1.js`  
Target endpoint: `GET /videos` on `catalog-service`  
Run: `docker compose exec holmes k6 run /workspace/k6/sprint-1.js`

run /workspace/k6/sprint-1.js

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: /workspace/k6/sprint-1.js
        output: -

     scenarios: (100.00%) 1 scenario, 20 max VUs, 1m40s max duration (incl. graceful stop):
              * default: Up to 20 looping VUs for 1m10s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)



  █ THRESHOLDS 

    errors
    ✓ 'rate<0.05' rate=0.00%

    http_req_failed
    ✓ 'rate<0.05' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 3986    56.563454/s
    checks_succeeded...: 100.00% 3986 out of 3986
    checks_failed......: 0.00%   0 out of 3986

    ✓ status is 200
    ✓ body is json-like

    CUSTOM
    errors.........................: 0.00%  0 out of 1993

    HTTP
    http_req_duration..............: avg=3.95ms   min=628.41µs med=3.44ms max=48.76ms  p(50)=3.44ms p(95)=7.95ms   p(99)=16.79ms 
      { expected_response:true }...: avg=3.95ms   min=628.41µs med=3.44ms max=48.76ms  p(50)=3.44ms p(95)=7.95ms   p(99)=16.79ms 
    http_req_failed................: 0.00%  0 out of 1993
    http_reqs......................: 1993   28.281727/s

    EXECUTION
    iteration_duration.............: avg=506.63ms min=500.87ms med=506ms  max=554.25ms p(50)=506ms  p(95)=512.98ms p(99)=519.87ms
    iterations.....................: 1993   28.281727/s
    vus............................: 1      min=1         max=20
    vus_max........................: 20     min=20        max=20

    NETWORK
    data_received..................: 4.0 MB 56 kB/s
    data_sent......................: 163 kB 2.3 kB/s




running (1m10.5s), 00/20 VUs, 1993 complete and 0 interrupted iterations
default ✓ [======================================] 00/20 VUs  1m10s

| Metric             | Value |
| ------------------ | ----- |
| p50 response time  | 3.44ms |
| p95 response time  | 7.95ms |
| p99 response time  | 16.79ms |
| Requests/sec (avg) | 28.28 |
| Error rate         | 0.00% |

These numbers are your baseline. Sprint 2 caching should improve them measurably.

---

## Blockers and Lessons Learned

One thing that slowed us down was coordinating a lot of services and Compose changes at the same time. Since multiple people were editing related files, we ran into merge conflicts and some mismatched ports or environment variables. Another issue was making sure service-to-service calls matched the latest version of a teammate’s code.

For the next sprint, we would probably coordinate shared files like `compose.yml` earlier so integration goes more smoothly.
