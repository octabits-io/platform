---
'@octabits-io/queue': minor
---

Queue review fixes — two behavioral bugs and a breaking-ish monitoring API change:

- **`stop()` was a silent no-op (worker leak).** `createQueueDomain().stop()` and `defineQueue`'s DLQ handler `stop()` called `boss.offWork(workerId)`, but pg-boss v12 `offWork` matches by queue NAME (an id is only accepted via `offWork(name, { id })`) — a worker UUID matched nothing and workers kept polling forever. Both now call `boss.offWork(queueName)`, which stops all workers for the queue; exact since each domain/DLQ handler registers at most one worker (double-start is now guarded).
- **BREAKING: `BossManager` monitoring methods now return `Result`.** `getJobById`, `getQueues`, `getQueueStats`, and `cancelJob` no longer throw raw pg errors or return `null`/`boolean` — they return `Result<T, E>` using the previously-dead error factories (`job_not_found`, `queue_not_found`, `job_cancel_error`, plus `queue_error` for unexpected throws).
- **Queue config drift fixed.** pg-boss v12 `createQueue` is `INSERT ... ON CONFLICT DO NOTHING`, so an existing queue kept stale settings (e.g. an old `deadLetter`) forever. The ensure step now calls `boss.updateQueue(name, options)` after `createQueue` (all passed options are updatable; only `policy`/`partition` are immutable and never passed). The dead `'already exists'` error sniff (v12 never throws it) was removed.
- **Honest DLQ audit records.** `DlqAuditRecord` is now a union discriminated on `validPayload`: valid records keep `payload: TPayload`, `errorMessage: 'Exhausted all retry attempts'`, and `attemptCount` = configured retry limit; schema-invalid records (dead-lettered on the FIRST attempt) carry `rawPayload: unknown`, `errorMessage: 'Payload failed schema validation; dead-lettered without retry'`, and `attemptCount: 1` — no more fabricated retry exhaustion.
- Double `startWorker()` / DLQ `start()` now returns a `queue_error` Result instead of silently leaking the first registration; `stop()` resets so a restart works.
- Job failure output now carries JSON-safe error detail: `JobFailedError.cause`/`jobId`/`queue` summaries for handler error Results, and a truncated stack + cause summary for thrown handler errors.
- DLQ worker tuning: `createDlqHandler(...).start({ pollingIntervalSeconds?, batchSize? })` (defaults unchanged: 30s / pg-boss default batch size); new `DlqWorkerOptions` export.
- Raw `Result` literals replaced with `ok()`/`err()` from `@octabits-io/foundation/result` (foundation is now a runtime import, per repo convention).
- `createQueueIfMissing` (never in the package API) was replaced by the internal `ensureQueueSynced` helper.
