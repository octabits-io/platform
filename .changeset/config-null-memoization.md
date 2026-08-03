---
'@octabits-io/framework': minor
---

Scoped config engine: null-resolved keys (no stored row and a null schema
default) are now memoized as absent resolutions in both the request memo and
the cross-scope cache, instead of re-querying the DB on every read batch that
contains them. Consumer-visible semantics are unchanged — such keys are still
omitted from results. `ScopedConfigCache.get/set` signatures widen to carry
`null` as the absence marker (`undefined` remains the miss signal).
