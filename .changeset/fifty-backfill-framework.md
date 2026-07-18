---
"@octabits-io/framework": minor
---

Add `./drizzle/backfill` — the one-shot data-backfill layer above SQL migrations: marker helpers (`ensureDataMigrationRunsTable` / `isDataMigrationCompleted` / `markDataMigrationCompleted`) over an on-demand `data_migration_runs` table, plus a `runBackfills` chain runner owning the skip / mark / partial-retry protocol for deploy pipelines.
