# Sprint 1 Report — [Team Name]

**Sprint:** 1 — Foundation  
**Tag:** `sprint-1`  
**Submitted:** [date, before 04.14 class]

---

## What We Built

[One or two paragraphs. What is running? What does `docker compose up` produce? What endpoints are live?]

---

## Individual Contributions

| Team Member | What They Delivered                                     | Key Commits            |
| ----------- | ------------------------------------------------------- | ---------------------- |
| [Name]      | [e.g. order-service with DB schema, health endpoint]    | [short SHA or PR link] |
| [Name]      | [e.g. restaurant-service, synchronous call integration] |                        |
| [Name]      | [e.g. compose.yml wiring, k6 baseline script]           |                        |

Verify with:

```bash
git log --author="Name" --oneline -- path/to/directory/
```

---

## What Is Working

- [ ] `docker compose up` starts all services without errors
- [ ] `docker compose ps` shows every service as `(healthy)`
- [ ] `GET /health` on every service returns `200` with DB and Redis status
- [ ] At least one synchronous service-to-service call works end-to-end
- [ ] k6 baseline test runs successfully

---

## What Is Not Working / Cut

[Be honest. What did you not finish? What did you cut from the sprint plan and why? How will you address it in Sprint 2?]

---

## k6 Baseline Results

Script: `k6/sprint-1.js`  
Run: `docker compose exec holmes k6 run /workspace/k6/sprint-1.js`

```

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
    ✓ 'rate<0.01' rate=0.00%

    http_req_duration
    ✓ 'p(95)<500' p(95)=6.15ms


  █ TOTAL RESULTS 

    checks_total.......: 4000    55.42556/s
    checks_succeeded...: 100.00% 4000 out of 4000
    checks_failed......: 0.00%   0 out of 4000

    ✓ status is 200
    ✓ response time < 500ms

    CUSTOM
    errors.........................: 0.00%  0 out of 2000

    HTTP
    http_req_duration..............: avg=3.85ms  min=1.11ms  med=3.54ms   max=56.07ms p(90)=5.41ms   p(95)=6.15ms  
      { expected_response:true }...: avg=3.85ms  min=1.11ms  med=3.54ms   max=56.07ms p(90)=5.41ms   p(95)=6.15ms  
    http_req_failed................: 0.00%  0 out of 2000
    http_reqs......................: 2000   27.71278/s

    EXECUTION
    iteration_duration.............: avg=504.8ms min=501.4ms med=504.51ms max=556.4ms p(90)=506.51ms p(95)=507.37ms
    iterations.....................: 2000   27.71278/s
    vus............................: 1      min=1         max=20
    vus_max........................: 20     min=20        max=20

    NETWORK
    data_received..................: 470 kB 6.5 kB/s
    data_sent......................: 164 kB 2.3 kB/s




running (1m12.2s), 00/20 VUs, 2000 complete and 0 interrupted iterations
default ✓ [======================================] 00/20 VUs  1m10s
```

| Metric             | Value |
| ------------------ | ----- |
| p50 response time  |       |
| p95 response time  | 6.15ms|
| p99 response time  |       |
| Requests/sec (avg) | 27.7  |
| Error rate         | 0     |

These numbers are your baseline. Sprint 2 caching should improve them measurably.

---

## Blockers and Lessons Learned

[What slowed you down? What would you do differently? What surprised you?]
