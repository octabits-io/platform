---
"@octabits-io/drizzle-toolkit": minor
---

Add `@octabits-io/drizzle-toolkit/migrate` subpath: `runMigrations({ connectionString,
migrationsFolder, ssl?, logger?, sessionVars? })`. Idempotent Drizzle migration runner
that connects, optionally applies session GUC variables via `set_config(name, value,
false)` (e.g. `{ 'app.system_mode': 'true' }` to bypass RLS for data migrations), runs
`migrate()` against the given folder, and always closes the connection.
