---
"@octabits-io/pii": minor
---

BREAKING: `createTenantKeyService` (and the `TenantKeyService`/`TenantKeyServiceDeps` types) removed. `createScopedKeyService` is the whole API — a multi-tenant consumer binds the scope to its own column: `createScopedKeyService({ scope: { column: 'tenantId', value: tenantId }, ... })`.
