---
"@octabits-io/schema": minor
---

New package **`@octabits-io/schema`** — generic multi-tenant Drizzle schema primitives, with zero domain coupling:

- Three base multi-tenant tables — `tenant` (generic `id`/`name`/`isDisabled`/`createdAt` only), `tenantEncryptionKey` (per-tenant Age recipient + encrypted identity + blind-index key), and `tenantConfig` (`(tenantId, key) → jsonb` store) — plus their Drizzle relations.
- Spreadable column-sets — `baseTenantColumns`, `tenantEncryptionKeyColumns`, `tenantConfigColumns` — so consumers can extend the base `tenant` with domain columns while reusing the generic core (the documented Drizzle "reuse common column definitions" pattern).
- `bytea` — a custom `bytea ↔ Buffer` column type for the encrypted key material.

Uses only `drizzle-orm/pg-core`; `drizzle-orm` is a peer dependency. Not part of the linked release group.
