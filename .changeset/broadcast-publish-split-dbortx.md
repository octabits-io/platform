---
'@octabits-io/framework': minor
---

Broadcast publish API reshape + shared `DbOrTx` seam:

- `drizzle/broadcast`: the modal `publish(db, payload, tx?)` is split into
  two methods with nominal contracts — `publish(db, payload)` (best-effort:
  database failures logged, never thrown) and `publishInTx(tx, payload)`
  (delivered at COMMIT, dropped on ROLLBACK, database failures throw).
  Previously the error contract silently switched on whether the optional
  `tx` slot was used. **Breaking**: the three-argument `publish` form and
  the `BroadcastDatabase` type are gone (no released consumers).
- `drizzle/db` gains `DbOrTx` — the shared minimal structural seam
  ("anything that can `execute` one SQL statement"; satisfied by a Drizzle
  db instance and by transaction contexts). `drizzle/broadcast` uses it
  directly; `EventOutboxDatabase` and `BackfillDatabase` now extend it
  instead of re-declaring `execute`.
