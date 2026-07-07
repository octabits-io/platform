---
"@octabits-io/drizzle-toolkit": minor
---

New `./config` subpath: a scoped key-value config engine (validate → encrypt → cache → default).

`createScopedConfigService({ scope?: { column, value }, table, schema, encryptedKeys, cacheableKeys, cipher, ... })` upserts schema-validated config entries, ciphers flagged keys into a `{ __encrypted }` envelope via an injected raw-string cipher (no pii dependency), and reads through a two-tier (request-scoped + shared LRU) cache with Zod-default application. `scope` is optional: scoped deployments pass `{ column, value }` (conflict target `(scopeColumn, key)`), single-scope deployments omit it (conflict target `(key)`). Pairs with `./scope`'s `scopedConfigColumns`.
