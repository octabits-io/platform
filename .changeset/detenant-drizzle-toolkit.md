---
"@octabits-io/drizzle-toolkit": minor
---

BREAKING: tenant vocabulary removed from the public API. The toolkit stays fully multi-tenant capable through generic scope seams — the scope column/key names are now always the consumer's to declare.

- `./tenant` subpath → **`./scope`**: `baseTenantColumns` → `baseScopeColumns`; `tenantEncryptionKeyColumns` → `encryptionKeyColumns` and `tenantConfigColumns` → `scopedConfigColumns`, both **without the baked-in `tenant_id` column** — spread the set and add your own scope column (name, FK, uniqueness) in your schema.
- `./crud`: `createBaseTenantScopedCrudService`, `BaseTenantScopedCrudConfig`, and `BaseTenantScopedCrudService` removed — use `createScopedCrudService({ scope: { column, value } })` with your column name.
- `./rls`: `createTenantDb` → `createScopedDb`; `TenantSessionVars` → `SessionVars`.
- `./idempotency`: the `tenantId?: string` option becomes `scope?: { column, value }`; `idempotencyKeyColumns` no longer ships a `tenant_id` column.
