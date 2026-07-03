---
"@octabits-io/queue": minor
---

Add `@octabits-io/queue`: a pg-boss-backed queue base layer.

- `createBossManager` — lifecycle + monitoring facade over a single shared
  pg-boss instance (start/stop/getJobById/getQueues/getQueueStats/cancelJob),
  with an injected logger.
- `createQueueDomain` — generic queue/worker/DLQ trio with Zod-validated
  payloads (DLQ created first with `retryLimit: 0`, main queue references it via
  `deadLetter`; payloads validated on both enqueue and dequeue).
- Monitoring types + error factories (`JobDetails`, `QueueStats`, `JobState`,
  `createJobNotFoundError`, …).

Domain-agnostic: payload types are supplied by the consumer, the logger is
injected, and all methods return `Result<T, E>` from `@octabits-io/foundation`.
The base payload constraint is `Record<string, unknown>`; multi-tenant callers
can opt in to the exported `SCHEMA_TENANT_JOB_PAYLOAD` (`{ tenantId, correlationId? }`).
