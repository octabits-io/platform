---
"@octabits-io/queue": minor
---

New `defineQueue()` declarative factory: generates worker + enqueuer + DLQ-handler factories from a name, a Zod payload schema, a handler factory, and optional retry/expire config, layered on `createQueueDomain`. DLQ auditing is decoupled from any table schema via an injected `onDlqAudit(scope, record)` sink, and partitioning is a generic `resolveScopeKey` seam (no tenant vocabulary).
