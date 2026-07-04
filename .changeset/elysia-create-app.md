---
"@octabits-io/elysia": minor
---

New **`createElysiaApp(routes, options)`** — the standard app skeleton every API repeated: `securityHeaders → clientIp → rateLimit → [caller plugins: cors/swagger] → errorHandler → routes`, each stage toggleable, with the routes' type preserved for Eden Treaty `type App` inference. cors/swagger are passed as ready-built plugin instances so this package stays free of `@elysiajs/*` deps. Plus **`registerGracefulShutdown({ logger, stop, signals? })`** — the SIGTERM/SIGINT → teardown → `exit(0)` tail duplicated in every `main()`.
