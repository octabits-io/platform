---
"@octabits-io/nuxt-ui-kit": patch
---

`pruneLocaleMap` now returns a dense `Record<string, string>` instead of
`LocaleMap<string>`.

Emptiness is exactly what the function removes, so the sparse return type made
every caller cast: an API whose request body is `Record<string, string>` — the
shape a validator normally infers for a per-locale map — rejects values typed
`string | undefined`, which is the one thing a pruned map is guaranteed not to
contain. Assigning the result back into a `LocaleMap<string>` stays legal, so
existing callers keep compiling.
