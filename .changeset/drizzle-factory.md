---
"@octabits-io/drizzle-toolkit": minor
---

Add `@octabits-io/drizzle-toolkit/factory` subpath: a generic, schema-parameterized
Drizzle instance factory. Exports `createDrizzle(schema, { pool, logger })` and
`createDrizzleFromClient(schema, { client, logger })` which augment a Drizzle
instance with `.tables` / `.schema` accessors and re-wrap `.transaction()` so the
tx passed into the callback stays augmented (recursively, for nested savepoints).
Sets the pg `INT8 → Number` type parser. Also exports the low-level `augmentDrizzle`
helper and the generic types `AppDatabase<TSchema>`, `AppTransaction<TSchema>`,
`DbOrTransaction<TSchema>`.
