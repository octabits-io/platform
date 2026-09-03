# @octabits-io/framework

Opinionated server framework toolkit for TypeScript backends. One package, granular
subpath exports — importing a module never drags in another module's vendor SDK
(everything heavy is an optional peer; you install only what you use).

Shared conventions across every surface:

- **Result pattern** — expected errors are values (`Result<T, E>`, discriminated on `ok`),
  never exceptions; `OctError` (`{ key, message }`) is the base error shape
- **Factory functions** — services are `createXxxService(deps)` returning plain objects
- **Zod at the boundaries** — payloads, config, and decrypted JSON are validated at runtime
- **Tenancy-agnostic seams** — generic optional scoping (`namespace?`, `scopeKey`,
  `scope: { column, value }`); multi-tenant and single-tenant consumers bind their own names

## Install

```bash
pnpm add @octabits-io/framework zod
# then add the optional peers for the modules you use, e.g.
pnpm add hono              # for ./hono
pnpm add pg-boss           # for ./queue
pnpm add drizzle-orm pg    # for ./drizzle/*
pnpm add wretch            # for ./zitadel and ./mail/brevo
```

## Modules

There is no root export — every module lives behind a subpath.

| Import | What it is | Docs |
|---|---|---|
| `./result` `./ioc` `./logger` `./utils` | Result types, IoC container (3 lifetimes + scopes), structured logger, helpers | [foundation](./docs/foundation.md) |
| `./proposal` | The AI reviewable-outcome contract: a run's result as typed operations (`update`/`create`/`delete`/`reorder`) against existing records, with what each replaces, provenance, drift guard, partial accept, zod wire schemas. zod only, browser-safe, imports no other module | [proposal](./docs/proposal.md) |
| `./config-schema` `./rbac` `./auth` `./signing` `./vault` `./captcha` `./captcha/altcha` | Zod config fragments, RBAC subset checks, JWT/API-key auth, scoped HKDF signing, Vault secret loader, captcha contract + ALTCHA | [foundation](./docs/foundation.md) |
| `./pii` | PII encryption: AES-256-GCM + age-format hybrid, blind indexes, per-scope keys | [foundation](./docs/foundation.md) |
| `./drizzle/*` | Drizzle ORM helpers: error→Result mapping, factory, migrations, one-shot data backfills, scope column-sets, CRUD, RLS (+ GUC-scope factory bridging `./ioc`), idempotency, scoped config, scoped-key store, job-audit store | [foundation](./docs/foundation.md) |
| `./ical` | iCal ingestion: fetcher + RRULE-expanding parser + day-blocking layer | [foundation](./docs/foundation.md) |
| `./events` `./events/postgres` `./drizzle/event-outbox` `./hono/events` | Two-lane event fan-out: transactional outbox + `pg_notify` (durable, replayable) and inline notifications (ephemeral); LISTEN client, relay, in-process hub, SSE endpoint as a plain fetch handler | [events](./docs/events.md) |
| `./drizzle/broadcast` | Fire-and-forget broadcast channel over `pg_notify` for cross-process coordination hints (cache invalidation etc.) — at-most-once, Zod-validated, outside the event taxonomy | [events](./docs/events.md) |
| `./server` `./server/testing` | Framework-agnostic server toolkit: env config, `runServer` + graceful shutdown, swagger options builder, response schemas; structural test-request helpers | [server](./docs/server.md) |
| `./hono` `./hono/mcp` `./hono/openapi` `./hono/flow` `./hono/events` | Hono middleware & app skeleton (request-scope + bearer-auth middleware, error mapping, rate limit, route-module factory); OpenAPI spec + validation; MCP server harness; `octaflow` read/control routes | [hono](./docs/hono.md) |
| `./queue` | pg-boss queue base: lifecycle facade + declarative queue/worker/DLQ trio (Drizzle DLQ-audit store behind `./drizzle/job-audit-store`) | [queue](./docs/queue.md) |
| `./storage` `./storage/s3` `./storage/postgres` | Namespaced blob storage contract + providers | [storage](./docs/storage.md) |
| `./mail` `./mail/smtp` `./mail/mailjet` `./mail/brevo` | Mail transport contract + transactional dispatch layer + providers | [mail](./docs/mail.md) |
| `./zitadel` | Zitadel Management API client: users, orgs, project grants, roles, invites, classified error taxonomy | [zitadel](./docs/zitadel.md) |

## Migrating from the split packages

This package supersedes five formerly separate packages. Imports map 1:1:

| Before | After |
|---|---|
| `@octabits-io/foundation/<module>` | `@octabits-io/framework/<module>` |
| `@octabits-io/elysia` (+ `/mcp`) | **removed** — see "The Elysia glue is gone" below |
| `@octabits-io/queue` | `@octabits-io/framework/queue` |
| `@octabits-io/storage` (+ `/s3`, `/postgres`) | `@octabits-io/framework/storage` (+ `/s3`, `/postgres`) |
| `@octabits-io/mail` (+ `/smtp`, `/mailjet`, `/brevo`) | `@octabits-io/framework/mail` (+ `/smtp`, `/mailjet`, `/brevo`) |

The wide `foundation` peer dependency the split packages declared is gone — the base
modules ship in this package.

## The Elysia glue is gone

`./elysia`, `./elysia/mcp`, `./elysia/flow`, `./elysia/events` and
`./elysia/testing` were removed once `./hono` reached parity. The Elysia layer
was always deliberately thin — the real logic lives in `./server`'s
framework-neutral cores, which are unchanged — so porting is a wide-but-shallow
rewrite of route and wiring files:

| Before | After |
|---|---|
| `@octabits-io/framework/elysia` | `@octabits-io/framework/hono` |
| `createElysiaApp` | `createHonoApp` |
| `createRequestScopePlugin` | `createRequestScopeMiddleware` |
| `createBearerAuthPlugin` | `createBearerAuthMiddleware` |
| `createErrorHandler` | `registerErrorHandler` |
| `body`/`query`/`params` route options | `octValidator` / `octApiValidator` |
| `@octabits-io/framework/elysia/mcp` | `@octabits-io/framework/hono/mcp` |
| `@octabits-io/framework/elysia/flow` | `@octabits-io/framework/hono/flow` |
| `@octabits-io/framework/elysia/events` | `@octabits-io/framework/hono/events` |
| `@octabits-io/framework/elysia/testing` | `@octabits-io/framework/server/testing` |
| Eden Treaty client | Hono `hc` (prefer the pre-compiled `hcWithType`) |

`elysia`, `elysia-mcp`, `elysia-rate-limit` and `@sinclair/typebox` are no
longer dependencies of this package, and the boundary lint now rejects them
package-wide. See [hono](./docs/hono.md) for the full surface.

The durable DAG workflow engine [`octaflow`](https://github.com/octabits-io/flow)
remains a separate, standalone package by design.

## Development

```bash
pnpm build             # tsdown
pnpm typecheck         # tsc --noEmit
pnpm lint              # module-boundary check (scripts/check-boundaries.mjs)
pnpm test:unit         # fast, no Docker
pnpm test:integration  # real backing services via testcontainers (Docker required)
```

Integration tests live next to their module as `<module>/integration.test.ts` and
each boots its own container(s) via testcontainers: `queue` → pg-boss on Postgres,
`storage` → MinIO, `vault` → HashiCorp Vault, `mail` → Mailpit (SMTP), `zitadel` →
Zitadel + Postgres. They validate the vendor adapters against real servers — the
behaviours mocks can't reach (S3 content-type round-tripping, KV-v2 hydration,
real SMTP delivery, Zitadel's error wording).

## License

MIT — see [LICENSE](./LICENSE). Vendored third-party code is listed in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
