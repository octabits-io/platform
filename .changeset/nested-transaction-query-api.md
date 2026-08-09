---
'@octabits-io/framework': patch
---

fix(drizzle): keep the relational query API on nested transactions

`augmentDrizzle` assigned its `.schema` alias unconditionally, overwriting the
`schema` field Drizzle's `PgTransaction` owns — its `RelationalSchemaConfig`.
`PgTransaction.transaction()` feeds exactly that field to the savepoint
transaction's constructor, so a nested transaction was built with no relational
config and came back with an empty `.query` API: `tx.query.foo` was `undefined`
one level down, while `.select()` / `.insert()` kept working. Top-level
transactions were unaffected (the driver's session builds those from its own
schema reference), which is why this only ever surfaced on the second level.

The alias is now only set when Drizzle does not already own that field. On a
transaction, `.schema` is therefore Drizzle's config rather than the schema
module; `.tables` is unchanged and remains the accessor to use for tables. The
RLS wrapper now reads the schema module from `.tables` for the same reason.
