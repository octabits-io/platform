---
"@octabits-io/foundation": patch
---

Fix jsonb double-parse on read in `drizzle/scope` and `drizzle/idempotency`: stored JSON-string values whose content is itself valid JSON (e.g. a postal code `"73235"`, `"true"`) came back type-mangled (number/boolean) because Drizzle's stock `jsonb()` re-parses driver-parsed strings, making schema-validating readers drop the key. `scopedConfigColumns.value` and `idempotencyKeyColumns.responseBody` now use the new exported `jsonbSafe` custom type (same `jsonb` SQL type — zero DDL — and identical write serialization; reads trust the driver's parsing). Requires a driver that parses jsonb result columns itself, as node-postgres does by default.
