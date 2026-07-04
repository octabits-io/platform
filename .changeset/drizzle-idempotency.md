---
"@octabits-io/drizzle-toolkit": minor
---

Add `./idempotency` subpath: a Stripe-style `X-Idempotency-Key` store over any
Drizzle Postgres table. `createIdempotencyService().begin()` classifies a
request as `cached` / `fresh` / `conflict`, with TTL expiry, request-hash
matching, and opportunistic cleanup of expired rows on commit. `tenantId` is
optional (multi-tenant composite-PK tables scope every query by it;
single-tenant tables omit it). The `db`, clock (`DateProvider`), and logger are
structural seams. Also exports the spreadable `idempotencyKeyColumns` column-set
plus the `hashRequest` / `isValidIdempotencyKey` helpers.
