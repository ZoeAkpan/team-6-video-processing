// to be pasted into compose file:

//   # quota-service:
//   #   build: ./quota-service
//   #   container_name: quota-service
//   #   restart: unless-stopped
//   #   ports:
//   #     - "3001:3001"          # expose on host for local testing
//   #   networks:
//   #     - team-net             # REQUIRED — makes it reachable from holmes
//   #   environment:
//   #     - DATABASE_URL=postgres://user:pass@postgres:5432/quotadb
//   #     - REDIS_URL=redis://redis:6379
//   #   depends_on:
//   #     postgres:
//   #       condition: service_healthy
//   #     redis:
//   #       condition: service_healthy
//   #   healthcheck:
//   #     test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
//   #     interval: 10s
//   #     timeout: 5s
//   #     retries: 3
//   #     start_period: 15s