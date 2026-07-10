---
"@octabits-io/foundation": minor
---

Fold `@octabits-io/pii`, `@octabits-io/drizzle-toolkit`, and `@octabits-io/ical` into foundation as subpath exports. The three standalone packages are deprecated; their code moved here unchanged.

Migration is a pure import-path rewrite:

- `@octabits-io/pii` → `@octabits-io/foundation/pii`
- `@octabits-io/drizzle-toolkit/<module>` → `@octabits-io/foundation/drizzle/<module>` (`db`, `factory`, `migrate`, `scope`, `crud`, `rls`, `idempotency`, `config`, `scoped-key-store`)
- `@octabits-io/ical` → `@octabits-io/foundation/ical`

Dependency changes on foundation: pii's `@noble/ciphers`/`@noble/curves`/`@noble/hashes`/`@scure/base` become hard dependencies; `drizzle-orm` (previously a hard dep of drizzle-toolkit), `pg`, and `ical.js` become optional peers used only by their respective subpaths. Consumers of `./drizzle/*` must declare `drizzle-orm` themselves (previously it came transitively).

The changesets `linked` group (foundation/drizzle-toolkit/pii/flow) is dissolved — flow now versions independently.
