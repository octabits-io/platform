---
"@octabits-io/framework": patch
---

Dedupe `createRequestScopeMiddleware` (Hono) across overlapping route mounts: when several modules sharing a mount prefix each carry the scope middleware, Hono copies every module's `use('*')` entry into the parent router, so one request could allocate a scope per overlapping module — each holding a pooled (RLS) DB connection for the rest of the request. The middleware now passes through when its context key is already populated: the first instance owns the scope, nested runs are no-ops. Middlewares with distinct `contextKey`s still stack.
