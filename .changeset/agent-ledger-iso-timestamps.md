---
"@octabits-io/framework": patch
---

`createDrizzleAgentLedgerStore` returns `appliedAt` / `revertedAt` as ISO strings. Drizzle's `mode: 'string'` timestamp hands back Postgres' own text form (`2026-09-03 18:13:11.096624+00`), which leaked through `record()` into API responses.
