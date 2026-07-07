---
'@octabits-io/drizzle-toolkit': minor
---

New `./scoped-key-store` module: `createDrizzleScopedKeyStore({ db, table, scope })` — the Drizzle adapter behind `@octabits-io/pii`'s structural `ScopedKeyStore` seam, so pii carries no `drizzle-orm` peer.

- Binds to one `{ column, value }` scope over an encryption-key table (spread `encryptionKeyColumns` from `./scope` + a unique scope column). `insert` stamps the scope column and maps a lost unique race (SQLSTATE 23505, walked through the driver/ORM `cause` chain) to `scoped_key_store_conflict`; `find` returns the four key fields for the scope (or `null`); `exists` / `destroy` are scoped by construction. `store.withDb(tx)` re-binds table + scope to a transaction.
- Row/error types (`NewScopedKeyRow`, `ScopedKeyRow`, `ScopedKeyStoreError`, …) are structural duplicates of pii's — no cross-package import, mirroring the `./config` `ConfigCipher` decoupling.
