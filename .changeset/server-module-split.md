---
"@octabits-io/framework": minor
---

New framework-agnostic `./server` module (+ `./server/testing`): the env-config helpers, `runServer`/`registerGracefulShutdown` (the `main()` tail; `runElysiaServer` stays as a deprecated alias), `buildSwaggerOptions`, the zod response schemas, and the request-test harness moved out of `./elysia` — none of them ever imported Elysia. `./elysia` and `./elysia/testing` re-export everything for full backwards compatibility.

Elysia-confinement hardening in `./elysia`: `buildSecurityHeaders` (pure options→header-map core of the security-headers plugin) and `resolveErrorResponse` (the framework-neutral error classifier behind `createErrorHandler`) are now exported; the boundary lint enforces per-file rules (`elysia-mcp` only in `mcp.ts`, `elysia-rate-limit` only in `rate-limit.ts`, and every `src/elysia` source file must actually import an elysia-tier vendor). New `docs/server.md`; `docs/elysia.md` now documents the confinement contract / porting story.
