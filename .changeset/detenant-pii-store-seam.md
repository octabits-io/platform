---
'@octabits-io/pii': minor
---

BREAKING: `createScopedKeyService` now depends on a structural `ScopedKeyStore` seam instead of a Drizzle db/table. `@octabits-io/pii` no longer imports or peer-depends on `drizzle-orm` — the encryption service owns no SQL/ORM logic.

- Deps change from `{ db, table, tableName, scope, masterKeyProvider, cache }` to `{ store, scope, masterKeyProvider, cache }`, where `store` is a four-method `ScopedKeyStore` (`insert` / `find` / `exists` / `destroy`), scope-bound at construction. The Postgres/Drizzle implementation ships as `createDrizzleScopedKeyStore` in `@octabits-io/drizzle-toolkit/scoped-key-store`.
- `generateKeyPair(tx)` → `generateKeyPair(txStore?)`: pass a transaction-bound store (e.g. `store.withDb(tx)`) instead of a raw db handle.
- Removed export: `ScopedKeyDb`. Added exports: `ScopedKeyStore`, `NewScopedKeyRow`, `ScopedKeyRow`, `ScopedKeyStoreError`, `ScopedKeyStoreConflictError`, `ScopedKeyStoreFailureError`.
- `drizzle-orm` dropped from `peerDependencies` (and the `peerDependenciesMeta` block removed). The public error surface (`scoped_key_generation_error` + `conflict`, `scoped_key_storage_error`, …) is unchanged.
