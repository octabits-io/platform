---
"@octabits-io/framework": minor
---

drizzle/db: shared `Db*` capability atoms (`DbSelectSource`, `DbInsertTarget`, `DbUpdateTarget`, `DbDeleteTarget`, `DbRelationalQuery`, `DbTransactionRunner`) alongside `DbOrTx` — every drizzle module's `*Database` seam is now a composition of these instead of a hand-rolled shape. The deep-chain seams (`EventOutboxDatabase`, `ScopedKeyStoreDatabase`, `JobAuditStoreDatabase`) flatten onto the atoms (strictly wider — anything that satisfied them before still does); their adapters now typecheck builder chains against drizzle-orm's real declarations via an internal typed view that never appears in a public signature. `RlsDatabase.execute` narrows to the shared `DbOrTx` signature (`(query: unknown) => Promise<unknown>`).
