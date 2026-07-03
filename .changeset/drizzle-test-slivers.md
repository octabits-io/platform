---
'@octabits-io/drizzle-test': minor
---

Add `unusedService<T>(name)` — a typed throwing-proxy stub for constructor
dependencies a test never exercises. Any property access throws an error naming
the stub, so a forgotten real dependency fails loudly instead of surfacing as an
opaque `undefined is not a function`.
