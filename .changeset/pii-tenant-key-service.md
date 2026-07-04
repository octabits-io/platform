---
"@octabits-io/pii": minor
---

New **`createTenantKeyService`** — per-tenant Age keypair + blind-index HMAC key management: lazy auto-generation (unique-constraint race-safe), master-key-encrypted storage, cached decryption, `getKeys` / `hasKeys` / `destroyKeys` / cache invalidation. Generic over the storage table (pass the tenant-encryption-key Drizzle table + its `db.query` key — pairs with `@octabits-io/drizzle-toolkit/tenant`) with a structural injected cache. Foundation dep switched from `workspace:^` to `^0.2.0` so the package is consumable via `file:` deps.
