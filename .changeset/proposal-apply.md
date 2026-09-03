---
"@octabits-io/framework": minor
---

`./proposal`: the apply-side helpers — `driftDigest`/`stableStringify` (the
guard a producer stores and a host recomputes), `detectDrift` (which accepted
updates would overwrite something other than what the reviewer saw), and
`invertOperations` (the operations that undo an application, derived from the
resolved operations and the ids the host assigned to creates — revert as a
second proposal, computed from the audit row). Still zod-only. `docs/proposal.md`
gains "The recipe", pointing at the demo server as the reference host.
