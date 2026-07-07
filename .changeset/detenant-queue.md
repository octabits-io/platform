---
"@octabits-io/queue": minor
---

BREAKING: `SCHEMA_TENANT_JOB_PAYLOAD` → `SCHEMA_SCOPED_JOB_PAYLOAD` and `TenantJobPayload` → `ScopedJobPayload`; the payload field is now `scopeKey` (was `tenantId`). Pairs with `defineQueue`'s `resolveScopeKey` seam; consumers that want a tenant-named field extend `SCHEMA_SYSTEM_JOB_PAYLOAD` with their own.
