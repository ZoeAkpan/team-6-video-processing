# Sprint 4 Report — Team 6

**Sprint:** 4 — Replication, Scaling, and Polish  
**Tag:** `sprint-4`  
**Submitted:** [date, before 05.05 class]

---

## What We Built

Upload, catalog, and quota service were the three services that we replicated. Load balancing helps to spread out traffic between different services so that the response time is relatively quick when running three concurrent services. We cleaned up the code by deleting unnecessary comments that repeated already known information, adding more time outs to avoid hangs, adding shutdown handlers in any services where it’s missing for a clean end, and then making sure our documentation was up to date. 

---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| Nishil Adina | Created Caddyfile and caddy service in compose file, added missing endpoint documentation to README, created new /upload/seed endpoint in upload-service to easily populate system with fake data. | `a5629bf`, PR 57, `4f78cbd` |
| Jihyun Kim | Added `serviceInstance` to quota health/API responses and structured logs so Caddy load balancing is visible across replicas. Verified quota state remains shared through `quota-db` and safe under replicated load. Updated Compose/Caddy scaling support, added Sprint 4 k6 scale and replica tests, and documented quota replica verification in the README. | `92a26d5` |
| [Duyen Tran]      | Add caddy load balancing across catalog-service replicas and update compose.yml to scale. Updated index.js to match the new schema. | `7b35fc4` |
| Anne-Colombe Sinkpon | Added Docker Compose scaling support for upload-service behind Caddy. Removed the fixed upload-service container name and host port binding so multiple upload-service replicas can run at the same time. Added an instanceId in health responses, response headers, and request logs so we can confirm different replicas are handling traffic. Refreshed endpoint documentation for upload-service and thumbnail-worker.| `e84cb30`, `aac912c`, `2ae66a2`, `2496adf` |
| Gabriella Wang | Added error handling for payload to avoid JSON parsing errors, added error handling for shutdown to make failures clearer, update flowchart  | `50635a0`|
| Zoë Akpan | Got rid of unnecessary comments, added shutdown, and just cleaned up code overall for upload-service, transcode-worker, and search-index-worker. Added timeout to declarations. Added SIGINT/SIGTERM shutdown for search-index-worker. Pushed failed jobs to the DLQ for transcode-worker. Removed any redundancy.| 50c44e9 | 
| Robert Winfield | Helped draft solutions for transcode worker and catalog service interaction, improved API documntation for transcode-worker health endpoint. | Approve PRs 51, 62 |
---

## Starting the System with Replicas

```bash
docker compose up -d --build --scale upload-service=3 --scale quota-service=3 --scale catalog-service=3
```

After startup:

```
NAME                                        IMAGE                                         COMMAND                  SERVICE               CREATED          STATUS                    PORTS
catalog-db                                  postgres:16                                   "docker-entrypoint.s…"   catalog-db            27 seconds ago   Up 22 seconds (healthy)   5432/tcp
holmes                                      team-6-video-processing-holmes                "sleep infinity"         holmes                27 seconds ago   Up 22 seconds             
moderation-db                               postgres:16                                   "docker-entrypoint.s…"   moderation-db         27 seconds ago   Up 22 seconds (healthy)   5432/tcp
moderation-worker                           team-6-video-processing-moderation-worker     "docker-entrypoint.s…"   moderation-worker     26 seconds ago   Up 11 seconds (healthy)   0.0.0.0:3007->3007/tcp
playback-db                                 postgres:16                                   "docker-entrypoint.s…"   playback-db           27 seconds ago   Up 22 seconds (healthy)   5432/tcp
playback-service                            team-6-video-processing-playback-service      "docker-entrypoint.s…"   playback-service      26 seconds ago   Up 11 seconds (healthy)   0.0.0.0:3003->3003/tcp
quota-db                                    postgres:16                                   "docker-entrypoint.s…"   quota-db              27 seconds ago   Up 22 seconds (healthy)   5432/tcp
redis                                       redis:7                                       "docker-entrypoint.s…"   redis                 27 seconds ago   Up 23 seconds (healthy)   6379/tcp
search-db                                   postgres:16                                   "docker-entrypoint.s…"   search-db             27 seconds ago   Up 22 seconds (healthy)   5432/tcp
search-index-worker                         team-6-video-processing-search-index-worker   "docker-entrypoint.s…"   search-index-worker   26 seconds ago   Up 11 seconds (healthy)   0.0.0.0:3006->3006/tcp
team-6-video-processing-caddy-1             caddy:2-alpine                                "caddy run --config …"   caddy                 25 seconds ago   Up 6 seconds              443/tcp, 0.0.0.0:80->80/tcp, 2019/tcp, 443/udp
team-6-video-processing-catalog-service-1   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       26 seconds ago   Up 10 seconds (healthy)   3002/tcp
team-6-video-processing-catalog-service-2   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       26 seconds ago   Up 11 seconds (healthy)   3002/tcp
team-6-video-processing-catalog-service-3   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       26 seconds ago   Up 9 seconds (healthy)    3002/tcp
team-6-video-processing-quota-service-1     team-6-video-processing-quota-service         "docker-entrypoint.s…"   quota-service         26 seconds ago   Up 15 seconds (healthy)   3001/tcp
team-6-video-processing-quota-service-2     team-6-video-processing-quota-service         "docker-entrypoint.s…"   quota-service         26 seconds ago   Up 16 seconds (healthy)   3001/tcp
team-6-video-processing-quota-service-3     team-6-video-processing-quota-service         "docker-entrypoint.s…"   quota-service         26 seconds ago   Up 16 seconds (healthy)   3001/tcp
team-6-video-processing-upload-service-1    team-6-video-processing-upload-service        "docker-entrypoint.s…"   upload-service        25 seconds ago   Up 7 seconds (healthy)    3000/tcp
team-6-video-processing-upload-service-2    team-6-video-processing-upload-service        "docker-entrypoint.s…"   upload-service        25 seconds ago   Up 8 seconds (healthy)    3000/tcp
team-6-video-processing-upload-service-3    team-6-video-processing-upload-service        "docker-entrypoint.s…"   upload-service        25 seconds ago   Up 9 seconds (healthy)    3000/tcp
thumbnail-worker                            team-6-video-processing-thumbnail-worker      "docker-entrypoint.s…"   thumbnail-worker      26 seconds ago   Up 11 seconds (healthy)   0.0.0.0:3005->3005/tcp
transcode-worker                            team-6-video-processing-transcode-worker      "docker-entrypoint.s…"   transcode-worker      27 seconds ago   Up 16 seconds (healthy)   0.0.0.0:3004->3004/tcp
upload-db                                   postgres:16                                   "docker-entrypoint.s…"   upload-db             27 seconds ago   Up 22 seconds (healthy)   0.0.0.0:5434->5432/tcp

```

---

## What Is Working

- [ ] At least 3 services replicated via `--scale`
- [ ] Load balancer distributes traffic across replicas (visible in logs)
- [ ] Services are stateless — multiple instances run without conflicts
- [ ] `docker compose ps` shows all replicas as `(healthy)`
- [ ] System is fully complete for team size

---

## What Is Not Working / Cut

---

## k6 Results

### Test 1: Scaling Comparison (`k6/sprint-4-scale.js`)

host:80 k6 run --env SCALE=single k6/sprint-4-scale.js


         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: k6/sprint-4-scale.js
        output: -

     scenarios: (100.00%) 1 scenario, 50 max VUs, 2m10s max duration (incl. graceful stop):
              * default: Up to 50 looping VUs for 1m40s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)



  █ THRESHOLDS 

    errors
    ✓ 'rate<0.01' rate=0.00%

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 15366   153.529347/s
    checks_succeeded...: 100.00% 15366 out of 15366
    checks_failed......: 0.00%   0 out of 15366

    ✓ status is 200
    ✓ body is json-like
    ✓ quota response includes replica id

    CUSTOM
    errors.........................: 0.00%  0 out of 5122

    HTTP
    http_req_duration..............: avg=13.9ms   min=1.52ms   med=9.31ms  max=364.8ms  p(50)=9.31ms  p(95)=26.38ms p(99)=155.93ms
      { expected_response:true }...: avg=13.9ms   min=1.52ms   med=9.31ms  max=364.8ms  p(50)=9.31ms  p(95)=26.38ms p(99)=155.93ms
    http_req_failed................: 0.00%  0 out of 5122
    http_reqs......................: 5122   51.176449/s

    EXECUTION
    iteration_duration.............: avg=515.01ms min=501.72ms med=510.5ms max=868.14ms p(50)=510.5ms p(95)=527.9ms p(99)=661.49ms
    iterations.....................: 5122   51.176449/s
    vus............................: 2      min=1         max=49
    vus_max........................: 50     min=50        max=50

    NETWORK
    data_received..................: 2.5 MB 25 kB/s
    data_sent......................: 533 kB 5.3 kB/s




running (1m40.1s), 00/50 VUs, 5122 complete and 0 interrupted iterations
default ✓ [======================================] 00/50 VUs  1m40s

(base) zoeakpan@vl965-172-31-249-243 team-6-video-processing % BASE_URL=http://localhost:80 k6 run --env SCALE=replicated k6/sprint-4-scale.js

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: k6/sprint-4-scale.js
        output: -

     scenarios: (100.00%) 1 scenario, 50 max VUs, 2m10s max duration (incl. graceful stop):
              * default: Up to 50 looping VUs for 1m40s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)



  █ THRESHOLDS 

    errors
    ✓ 'rate<0.01' rate=0.00%

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 15246   152.15561/s
    checks_succeeded...: 100.00% 15246 out of 15246
    checks_failed......: 0.00%   0 out of 15246

    ✓ status is 200
    ✓ body is json-like
    ✓ quota response includes replica id

    CUSTOM
    errors.........................: 0.00%  0 out of 5082

    HTTP
    http_req_duration..............: avg=17.78ms  min=1.27ms   med=7.65ms   max=1.92s p(50)=7.65ms   p(95)=34.66ms p(99)=237.02ms
      { expected_response:true }...: avg=17.78ms  min=1.27ms   med=7.65ms   max=1.92s p(50)=7.65ms   p(95)=34.66ms p(99)=237.02ms
    http_req_failed................: 0.00%  0 out of 5082
    http_reqs......................: 5082   50.718537/s

    EXECUTION
    iteration_duration.............: avg=518.85ms min=501.47ms med=508.63ms max=2.42s p(50)=508.63ms p(95)=535.9ms p(99)=737.44ms
    iterations.....................: 5082   50.718537/s
    vus............................: 3      min=1         max=49
    vus_max........................: 50     min=50        max=50

    NETWORK
    data_received..................: 2.4 MB 24 kB/s
    data_sent......................: 529 kB 5.3 kB/s




running (1m40.2s), 00/50 VUs, 5082 complete and 0 interrupted iterations
default ✓ [======================================] 00/50 VUs  1m40s


| Metric | 1 replica | 3 replicas | Change |
| ------ | --------- | ---------- | ------ |
| p50    |9.31ms | 7.65ms | -18%|
| p95    |26.38ms |34.66ms |31% |
| p99    |155.93ms |237.02ms | 52%|
| RPS    |51.18 |50.72 | -0.9%|

[Explain the improvement. Which replica count started to show diminishing returns?]

There was really no improvement except for p50, where we went from 9.31ms with 1 replica to 7.65ms with 3 replicas. Everything after p50, like p95 and p99, had worse performance. Therefore, replica 3 had diminishing returns, which suggests that just 1 replica is good enough for our system.  

### Test 2: Replica Failure (`k6/sprint-4-replica.js`)

Timeline:

| Time | Event |
| ---- | ----- |
| 0s   | k6 started, 3 replicas running |
| 35s | Killed replica: `docker stop team-6-video-processing-catalog-service-1` |
| 35-50s | Surviving replicas absorbed traffic |
| 50s | Replica restarted: `docker start team-6-video-processing-catalog-service-1` |
| 55s | Traffic redistributed, back to normal |

```

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: /workspace/k6/sprint-4-replica.js
        output: -

     scenarios: (100.00%) 1 scenario, 20 max VUs, 3m40s max duration (incl. graceful stop):
              * default: Up to 20 looping VUs for 3m10s over 4 stages (gracefulRampDown: 30s, gracefulStop: 30s)



  █ THRESHOLDS 

    errors
    ✓ 'rate<0.01' rate=0.00%

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 6746    35.468961/s
    checks_succeeded...: 100.00% 6746 out of 6746
    checks_failed......: 0.00%   0 out of 6746

    ✓ status is 200

    CUSTOM
    errors.........................: 0.00%  0 out of 6746

    HTTP
    http_req_duration..............: avg=4.24ms   min=1.34ms   med=3.62ms   max=77.11ms  p(50)=3.62ms   p(95)=7.78ms   p(99)=13.41ms 
      { expected_response:true }...: avg=4.24ms   min=1.34ms   med=3.62ms   max=77.11ms  p(50)=3.62ms   p(95)=7.78ms   p(99)=13.41ms 
    http_req_failed................: 0.00%  0 out of 6746
    http_reqs......................: 6746   35.468961/s

    EXECUTION
    iteration_duration.............: avg=505.33ms min=501.57ms med=504.67ms max=578.13ms p(50)=504.67ms p(95)=509.24ms p(99)=515.52ms
    iterations.....................: 6746   35.468961/s
    vus............................: 1      min=1         max=20
    vus_max........................: 20     min=20        max=20

    NETWORK
    data_received..................: 1.4 MB 7.2 kB/s
    data_sent......................: 580 kB 3.1 kB/s




running (3m10.2s), 00/20 VUs, 6746 complete and 0 interrupted iterations
default ✓ [======================================] 00/20 VUs  3m10s

```

During failure — `docker compose ps`:

```
NAME                                        IMAGE                                         COMMAND                  SERVICE               CREATED         STATUS                   PORTS
catalog-db                                  postgres:16                                   "docker-entrypoint.s…"   catalog-db            4 minutes ago   Up 4 minutes (healthy)   5432/tcp
holmes                                      team-6-video-processing-holmes                "sleep infinity"         holmes                4 minutes ago   Up 4 minutes             
moderation-db                               postgres:16                                   "docker-entrypoint.s…"   moderation-db         4 minutes ago   Up 4 minutes (healthy)   5432/tcp
moderation-worker                           team-6-video-processing-moderation-worker     "docker-entrypoint.s…"   moderation-worker     8 minutes ago   Up 4 minutes (healthy)   0.0.0.0:3007->3007/tcp
playback-db                                 postgres:16                                   "docker-entrypoint.s…"   playback-db           4 minutes ago   Up 4 minutes (healthy)   5432/tcp
playback-service                            team-6-video-processing-playback-service      "docker-entrypoint.s…"   playback-service      8 minutes ago   Up 4 minutes (healthy)   0.0.0.0:3003->3003/tcp
quota-db                                    postgres:16                                   "docker-entrypoint.s…"   quota-db              4 minutes ago   Up 4 minutes (healthy)   5432/tcp
redis                                       redis:7                                       "docker-entrypoint.s…"   redis                 8 minutes ago   Up 8 minutes (healthy)   6379/tcp
search-db                                   postgres:16                                   "docker-entrypoint.s…"   search-db             4 minutes ago   Up 4 minutes (healthy)   5432/tcp
search-index-worker                         team-6-video-processing-search-index-worker   "docker-entrypoint.s…"   search-index-worker   8 minutes ago   Up 4 minutes (healthy)   0.0.0.0:3006->3006/tcp
team-6-video-processing-caddy-1             caddy:2-alpine                                "caddy run --config …"   caddy                 4 minutes ago   Up 4 minutes             443/tcp, 0.0.0.0:80->80/tcp, 2019/tcp, 443/udp
team-6-video-processing-catalog-service-2   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       8 minutes ago   Up 4 minutes (healthy)   3002/tcp
team-6-video-processing-catalog-service-3   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       8 minutes ago   Up 4 minutes (healthy)   3002/tcp
team-6-video-processing-quota-service-1     team-6-video-processing-quota-service         "docker-entrypoint.s…"   quota-service         8 minutes ago   Up 4 minutes (healthy)   3001/tcp
team-6-video-processing-upload-service-1    team-6-video-processing-upload-service        "docker-entrypoint.s…"   upload-service        8 minutes ago   Up 4 minutes (healthy)   3000/tcp
thumbnail-worker                            team-6-video-processing-thumbnail-worker      "docker-entrypoint.s…"   thumbnail-worker      8 minutes ago   Up 4 minutes (healthy)   0.0.0.0:3005->3005/tcp
transcode-worker                            team-6-video-processing-transcode-worker      "docker-entrypoint.s…"   transcode-worker      8 minutes ago   Up 7 minutes (healthy)   0.0.0.0:3004->3004/tcp
upload-db                                   postgres:16                                   "docker-entrypoint.s…"   upload-db             4 minutes ago   Up 4 minutes (healthy)   0.0.0.0:5434->5432/tcp

```

After restart — `docker compose ps`:

```
NAME                                        IMAGE                                         COMMAND                  SERVICE               CREATED         STATUS                            PORTS
catalog-db                                  postgres:16                                   "docker-entrypoint.s…"   catalog-db            5 minutes ago   Up 5 minutes (healthy)            5432/tcp
holmes                                      team-6-video-processing-holmes                "sleep infinity"         holmes                5 minutes ago   Up 5 minutes                      
moderation-db                               postgres:16                                   "docker-entrypoint.s…"   moderation-db         5 minutes ago   Up 5 minutes (healthy)            5432/tcp
moderation-worker                           team-6-video-processing-moderation-worker     "docker-entrypoint.s…"   moderation-worker     8 minutes ago   Up 4 minutes (healthy)            0.0.0.0:3007->3007/tcp
playback-db                                 postgres:16                                   "docker-entrypoint.s…"   playback-db           5 minutes ago   Up 5 minutes (healthy)            5432/tcp
playback-service                            team-6-video-processing-playback-service      "docker-entrypoint.s…"   playback-service      8 minutes ago   Up 4 minutes (healthy)            0.0.0.0:3003->3003/tcp
quota-db                                    postgres:16                                   "docker-entrypoint.s…"   quota-db              5 minutes ago   Up 5 minutes (healthy)            5432/tcp
redis                                       redis:7                                       "docker-entrypoint.s…"   redis                 8 minutes ago   Up 8 minutes (healthy)            6379/tcp
search-db                                   postgres:16                                   "docker-entrypoint.s…"   search-db             5 minutes ago   Up 5 minutes (healthy)            5432/tcp
search-index-worker                         team-6-video-processing-search-index-worker   "docker-entrypoint.s…"   search-index-worker   8 minutes ago   Up 4 minutes (healthy)            0.0.0.0:3006->3006/tcp
team-6-video-processing-caddy-1             caddy:2-alpine                                "caddy run --config …"   caddy                 5 minutes ago   Up 4 minutes                      443/tcp, 0.0.0.0:80->80/tcp, 2019/tcp, 443/udp
team-6-video-processing-catalog-service-1   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       8 minutes ago   Up 4 seconds (health: starting)   3002/tcp
team-6-video-processing-catalog-service-2   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       8 minutes ago   Up 4 minutes (healthy)            3002/tcp
team-6-video-processing-catalog-service-3   team-6-video-processing-catalog-service       "docker-entrypoint.s…"   catalog-service       8 minutes ago   Up 4 minutes (healthy)            3002/tcp
team-6-video-processing-quota-service-1     team-6-video-processing-quota-service         "docker-entrypoint.s…"   quota-service         8 minutes ago   Up 4 minutes (healthy)            3001/tcp
team-6-video-processing-upload-service-1    team-6-video-processing-upload-service        "docker-entrypoint.s…"   upload-service        8 minutes ago   Up 4 minutes (healthy)            3000/tcp
thumbnail-worker                            team-6-video-processing-thumbnail-worker      "docker-entrypoint.s…"   thumbnail-worker      8 minutes ago   Up 4 minutes (healthy)            0.0.0.0:3005->3005/tcp
transcode-worker                            team-6-video-processing-transcode-worker      "docker-entrypoint.s…"   transcode-worker      8 minutes ago   Up 8 minutes (healthy)            0.0.0.0:3004->3004/tcp
upload-db                                   postgres:16                                   "docker-entrypoint.s…"   upload-db             5 minutes ago   Up 5 minutes (healthy)            0.0.0.0:5434->5432/tcp

```

---

## Blockers and Lessons Learned

The parts needed to come together for the K6 tests, so we struggled with avoiding errors here. When we initially ran the tests, we had an 100% error rate and had to work on debugging to figure out why this happened close to the due date. We had a limited amount of time to finish the project, but we learned that we should be finishing the code in advance, which will give us more time to debug later on in the week. 


