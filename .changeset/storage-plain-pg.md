---
"@octabits-io/storage": minor
---

BREAKING: the Postgres blob provider (`@octabits-io/storage/postgres`) is rewritten on raw `pg` instead of the drizzle query builder.

- **Config takes a `pg` `Pool`.** Both `createPostgresObjectStorageService` and `createPostgresObjectStorageUrlProvider` now accept `{ pool }` (unifying the old `drizzle:`/`db:` split). Pass a `pg` `Pool` instead of a drizzle instance.
- **Peer swap:** the optional peer `drizzle-orm` is replaced by `pg` (`^8.22.0`, optional). Install `pg` (and `@types/pg` as a dev dep) for the provider; drop `drizzle-orm` if it was only used here.
- **`objectStorageTable` and `StorageDrizzle` are removed.** Migration-managed setups use the new exported `objectStorageDdl()` — it emits the `object_storage` table, both indexes, and the `object_storage_namespace_key_unique` constraint — then pass `autoCreateTable: false`.
- **Uploads are now a single `INSERT … ON CONFLICT (namespace, key) DO UPDATE` upsert** (also fixing the previous select-then-write race). This **requires** the `(namespace, key)` unique constraint: the default bootstrap adds it automatically, but a legacy table with `autoCreateTable: false` that lacks it fails uploads with a pointed `internal_error` (apply `objectStorageDdl()` or enable `autoCreateTable`).
- **`getObjectData().value.lastModified` is now an ISO 8601 string** (e.g. `2026-01-02T03:04:05.000Z`), normalized from the `pg` `Date`. Still a string; format only.
