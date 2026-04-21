# Sprint 2 Report — Team 6


**Sprint:** 2 — Async Pipelines and Caching 
**Tag:** `sprint-2` 
**Submitted:** [04/20/2026, before 04.21 class]


---


## What We Built


[What cache did you add? What queue and worker are running? What does the async pipeline do?]


Redis cache was added to the `GET /videos` endpoint in catalog-service. For each request, service checks Redis for the available key before querying Postgres. For a cache miss, the result is stored in Redis, so the first request within each window hits Postgres. Other requests are dealt with by Redis.


The async pipeline runs through the transcode worker and upload-service. If a POST /upload request goes through, the upload service creates an initial job status record in Redis, then pushes the job onto the queue for transcode worker; we see this after the insert. Transcode worker runs a BLPOP loop that deals with jobs, processes each one, then marks the job as transcode-complete. Jobs with missing fields go to transcode-dead-letter.


Thumbnail worker now extracts thumbnails, writes thumbnail references to the catalog database, and there is a /health endpoint.


The moderation worker handles Redis pub/sub events for video moderation.


GET /videos endpoint is now implemented in catalog-service.

Search index worker has a health check endpoint and can parse video metadata into a search database. It can also handle duplicate videos by updating the existing data without adding another entry. 

The transcode now has a health endpoint that provides the health of the container as well as the health of the transcode-jobs queue.

---


## Individual Contributions


| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| Nishil Adina| Fixed issue causing some services to appear as unhealthy,  | |
| Zoë Akpan      |Implemented idempotency for upload worker. Implemented K6 test for caching. Implemented K6 test for a burst of write requests and testing the async pipeline. Implemented upload service being able to push a job onto the Redis transcode queue. Collectively completed the sprint plan. Completed most of the sprint report. | PR numbers: 30, 27, 26, 23 |
| [Anne-Colombe Sinkpon]      | Added a GET /health endpoint for thumbnail worker (showing current queue depth, dead letter queue depth, and timestamp of last successfully processed job), made thumbnail worker listen for Redis transcode-complete events, simulated thumbnail extraction, made thumbnail worker write thumbnail references into catalog thumbnail table.  | |
| Gabriella Wang      |Added a health check endpoint for search index worker, implemented search database and adding video metadata entries into the database, implemented idempotency for search index worker. Also updated compose.yml to include search index worker and search db. | `c219f08`, `d9c2113`, `0986218` |
| Robert Winfield     | Added health check endpoint for transcode-worker that displays critical Redis queue info such as the depth, dead letter queue depth, and the time of the last job processed. Updated compose.yml to include healthcheck for transcode-worker service. | `c57892f`, `469ce37`, `77c6163` |
| [Name]      | | |
| [Name]      | | |
| [Name]      | | |
| [Name]      | | |


---


## What Is Working


- [ ] Redis cache in use — repeated reads do not hit the database
- [ ] Async pipeline works end-to-end (message published → worker consumes → action taken)
- [ ] At least one write path is idempotent (same request twice produces same result)
- [ ] Worker logs show pipeline activity in `docker compose logs`
- [ ] Worker `GET /health` returns queue depth, DLQ depth, and last-job-at


---


## What Is Not Working / Cut


---


## k6 Results


### Test 1: Caching Comparison (`k6/sprint-2-cache.js`)




        /\      Grafana   /‾‾/ 
   /\  /  \     |\  __   /  /  
  /  \/    \    | |/ /  /   ‾‾\
 /          \   |   (  |  (‾)  |
/ __________ \  |_|\_\  \_____/




    execution: local
       script: /workspace/k6/sprint-2-cache.js
       output: -


    scenarios: (100.00%) 1 scenario, 20 max VUs, 1m40s max duration (incl. graceful stop):
             * default: Up to 20 looping VUs for 1m10s over 3 stages (gracefulRampDown: 30s, gracefulStop: 30s)






 █ THRESHOLDS


   errors
   ✓ 'rate<0.05' rate=0.00%


   http_req_failed
   ✓ 'rate<0.05' rate=0.00%




 █ TOTAL RESULTS


   checks_total.......: 3994    56.751813/s
   checks_succeeded...: 100.00% 3994 out of 3994
   checks_failed......: 0.00%   0 out of 3994


   ✓ status is 200
   ✓ body is json-like


   CUSTOM
   errors.........................: 0.00%  0 out of 1997


   HTTP
   http_req_duration..............: avg=3.43ms   min=468.7µs  med=2.86ms   max=67.93ms  p(50)=2.86ms   p(95)=7.24ms   p(99)=12.16ms
     { expected_response:true }...: avg=3.43ms   min=468.7µs  med=2.86ms   max=67.93ms  p(50)=2.86ms   p(95)=7.24ms   p(99)=12.16ms
   http_req_failed................: 0.00%  0 out of 1997
   http_reqs......................: 1997   28.375907/s


   EXECUTION
   iteration_duration.............: avg=506.19ms min=500.78ms med=505.42ms max=569.14ms p(50)=505.42ms p(95)=511.91ms p(99)=520.2ms
   iterations.....................: 1997   28.375907/s
   vus............................: 1      min=1         max=20
   vus_max........................: 20     min=20        max=20


   NETWORK
   data_received..................: 4.0 MB 56 kB/s
   data_sent......................: 164 kB 2.3 kB/s








running (1m10.4s), 00/20 VUs, 1997 complete and 0 interrupted iterations
default ✓ [======================================] 00/20 VUs  1m10s


| Metric | Sprint 1 Baseline | Sprint 2 Cached | Change |
| ------ | ----------------- | --------------- | ------ |
| p50    |3.44ms|2.86ms|17% faster |
| p95    |7.95ms |7.24ms |9% faster |
| p99    |16.79ms |12.16ms |28% faster |
| RPS    |28.28 |28.38ms |Same, but still, Sprint 2 can handle more requests |


Caching reduced p66 by 28%, p95 by 9%, and p50 by 17% just with 5 seeded videos. The difference would likely be even larger with additional videos added to the dataset, as Postgres query time grows with the amount of data. But even with a limited number of videos, there's a clear benefit to caching: better traffic handling.


### Test 2: Async Pipeline Burst (`k6/sprint-2-async.js`)


```
[Paste k6 summary output here]
```


Worker health during the burst (hit `/health` while k6 is running):


```json
[Paste an example health response showing non-zero queue depth]
```


Idempotency check: [Describe what you sent and what happened when you sent the same idempotency key twice.]


---


## Blockers and Lessons Learned


People in general need to either warn others that they are going to do work late or start earlier. A lot of parts depended on other parts (pipeline), and some people were straight up doing these dependent parts late at night. This resulted in others having to work last-minute the day it was due just to finish the sprint. You can do that for individual projects, but it sucks for everyone when you're doing this on a group project.





