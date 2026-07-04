---
"@octabits-io/elysia": minor
---

Add `createHealthRoutes` (root export): the `/health` liveness alias + `/live` +
`/ready` route trio every API duplicates, plus the `onError` that maps `/ready`
failures to a `503` with `{ status: 'error', message }`. The readiness probe is
the injected `checkReady: () => Promise<void>` seam (reynt passes a
`SELECT 1`-via-Drizzle closure) — no db/container coupling. Response bodies are
byte-equivalent to the reynt routes: `{ status: 'ok' }` (liveness) and
`{ status: 'ok', db: 'connected' }` (readiness). `prefix`, `tags`,
`readyErrorMessage`, and an optional foundation `Logger` are configurable. Also
exports the `SCHEMA_HEALTH_LIVE_RESPONSE` / `SCHEMA_HEALTH_READY_RESPONSE` zod
schemas.
