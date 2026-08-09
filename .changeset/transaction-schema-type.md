---
'@octabits-io/framework': patch
---

fix(drizzle): stop typing `.schema` onto a transaction

The nested-transaction fix made the runtime right and left the types behind.
`augmentDrizzle` no longer overwrites `PgTransaction.schema`, so on a
transaction that field is Drizzle's `RelationalSchemaConfig` — but
`AppTransaction` and `DbOrTransaction` were plain aliases of `AppDatabase`,
which declares `schema: TSchema`. `tx.schema.someTable` therefore compiled and
handed back `undefined`, with nothing but a doc comment against it. (Drizzle
declares `PgTransaction.schema` `protected`, so the public claim came entirely
from the alias.)

`.schema` is now declared only on `AppDatabase`, the connection — the only place
the factory sets it. `AppTransaction` is the shared shape without it, and
`DbOrTransaction` aliases the transaction rather than the connection, so it
promises only what both actually have. An `AppDatabase` is still assignable
wherever a transaction or either is accepted, so `tx?: DbOrTransaction`
parameters keep taking a `db`; the reverse no longer type-checks, which is the
point.

`.tables` is unchanged and remains the accessor for tables on both. Code that
read `.schema` off a value typed as a transaction or `DbOrTransaction` now fails
to compile — that read was already returning the wrong object at runtime.
