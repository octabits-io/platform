---
"@octabits-io/elysia": minor
---

Fix `createMcpRoutes` returning 404 for every request when the plugin is `.use()`'d under a prefixed parent (e.g. `/api` → `/scope/:scopeKey` → `/mcp`): the inner elysia-mcp app mirrored the plugin's own `prefix`, so the delegated request URL — which carries the parent prefixes — matched nothing inside `inner.handle()` while the outer routes still appeared in `app.routes`. The inner app is now location-independent: matched requests are re-addressed to a fixed internal pathname before delegation, and the outer routes compose like any plain Elysia plugin. This was never an upstream Elysia router bug — plain nested-prefix `.all()`/wildcard routes dispatch fine on elysia 1.4.29.

`resolveScope` now receives the original (public) request URL as a new `url` argument — read it instead of `context.request.url`, whose pathname is the internal re-addressed one (method, headers, body, and query string are unchanged).

Also documented: on Node runtimes, elysia-mcp ≤0.1.1 calls `Bun.randomUUIDv7()` on every stateless request — test setups must shim it after importing elysia (see the module docs).
