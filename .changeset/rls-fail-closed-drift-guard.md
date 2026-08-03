---
"@octabits-io/framework": minor
---

drizzle/rls: fail-closed drift guard on the scoped-db proxy. Unclassified Drizzle members now throw on use instead of silently running without the scope's GUCs (where RLS policies would match zero rows) — functions throw on invocation, object-valued namespaces on access; absent properties still read as `undefined`. New exports `QUERY_NAMESPACE_METHODS` and `SCOPED_DB_PASSTHROUGH_PROPS` carry the classification, and a contract test enumerates the installed drizzle-orm's db surface so any added/renamed/removed entry point fails the unit suite at upgrade time instead of drifting silently.
