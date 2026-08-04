---
"@octabits-io/framework": minor
---

Remove the deprecated `runElysiaServer` / `RunElysiaServerOptions` aliases from `./server` (and the `./elysia` re-export). They were renamed to `runServer` / `RunServerOptions` in 0.17.0 — same function, nothing about it is Elysia-specific. Migration: rename the import; the `./elysia` compat re-export of the rest of the server toolkit is unchanged.
