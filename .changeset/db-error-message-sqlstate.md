---
"@octabits-io/framework": minor
---

Database error mapping: SQLSTATE-carrying messages, broader code coverage, cause-chain walking

`withDbErrorHandling` and `handleTransactionError` previously set `message` to the
outer (Drizzle) error's message — typically just `Failed query: …` — dropping the
actual PostgreSQL diagnosis that lives on `.cause`. Consumers that only surface
`.message` (API responses, re-wrapped errors, test output) could not tell a
deadlock from a unique violation.

- The mapped `OctDatabaseError.message` is now prefixed with the raw SQLSTATE
  and, when distinct, the PostgreSQL error's own message:
  `[40P01 deadlock detected] Failed query: …`. The structured
  `code`/`constraint` fields are unchanged.
- `PostgresErrorCode` gains four new mappings: `exclusion_violation` (23P01),
  `insufficient_privilege` (42501, incl. row-level-security policy violations),
  `lock_not_available` (55P03), and `query_canceled` (57014). These previously
  mapped to `unknown`.
- `extractPgError` now walks the `cause` chain to a bounded depth instead of
  looking exactly one level deep, so a re-wrapped Drizzle error still maps
  instead of rethrowing.
