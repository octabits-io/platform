---
"@octabits-io/flow": minor
---

store-pg: consistent schema qualification across all DDL and runtime SQL, making a dedicated Postgres schema a first-class deployment option. `flowGateDdl` and `createPgStepGate` now accept `schema` (default `'public'`), matching the store and event sink — previously the gate's two tables resolved via `search_path` while the rest were pinned to `public`, so a non-default `search_path` could split the tables across schemas. DDL for a non-default schema now emits `CREATE SCHEMA IF NOT EXISTS` (new `createSchemaDdl` export).
