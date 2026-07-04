---
"@octabits-io/drizzle-toolkit": minor
---

New **`./crud`** subpath — `createBaseTenantScopedCrudService`, a generic factory for tenant-scoped CRUD services over any Drizzle table with `id` + `tenantId` columns: paginated `list` (+total), `getById`, `create`, `update`, `delete`, every query auto-scoped with `eq(table.tenantId, tenantId)` from the construction-time tenant. Optional `actorId` stamps `created_by`/`updated_by` audit columns. Structural `CrudDatabase` seam (any augmented Drizzle instance or transaction); errors are `OctDatabaseError` / keyed `ResourceNotFoundError` in foundation `Result`s.
