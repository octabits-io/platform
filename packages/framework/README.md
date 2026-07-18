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
pnpm add elysia            # for ./elysia
pnpm add pg-boss           # for ./queue
pnpm add drizzle-orm pg    # for ./drizzle/*
pnpm add wretch            # for ./zitadel and ./mail/brevo
```

## Modules

There is no root export — every module lives behind a subpath.

| Import | What it is | Docs |
|---|---|---|
| `./result` `./ioc` `./logger` `./utils` | Result types, IoC container (3 lifetimes + scopes), structured logger, helpers | [foundation](./docs/foundation.md) |
| `./config-schema` `./rbac` `./auth` `./signing` `./vault` `./captcha` `./captcha/altcha` | Zod config fragments, RBAC subset checks, JWT/API-key auth, scoped HKDF signing, Vault secret loader, captcha contract + ALTCHA | [foundation](./docs/foundation.md) |
| `./pii` | PII encryption: AES-256-GCM + age-format hybrid, blind indexes, per-scope keys | [foundation](./docs/foundation.md) |
| `./drizzle/*` | Drizzle ORM helpers: error→Result mapping, factory, migrations, one-shot data backfills, scope column-sets, CRUD, RLS (+ GUC-scope factory bridging `./ioc`), idempotency, scoped config, scoped-key store, job-audit store | [foundation](./docs/foundation.md) |
| `./ical` | iCal ingestion: fetcher + RRULE-expanding parser + day-blocking layer | [foundation](./docs/foundation.md) |
| `./elysia` `./elysia/mcp` `./elysia/testing` | Elysia middleware & app skeleton (request-scope + bearer-auth plugins, error mapping, rate limit, server runner); MCP server harness; test-request helpers | [elysia](./docs/elysia.md) |
| `./queue` | pg-boss queue base: lifecycle facade + declarative queue/worker/DLQ trio (Drizzle DLQ-audit store behind `./drizzle/job-audit-store`) | [queue](./docs/queue.md) |
| `./storage` `./storage/s3` `./storage/postgres` | Namespaced blob storage contract + providers | [storage](./docs/storage.md) |
| `./mail` `./mail/smtp` `./mail/mailjet` `./mail/brevo` | Mail transport contract + transactional dispatch layer + providers | [mail](./docs/mail.md) |
| `./zitadel` | Zitadel Management API client: users, orgs, project grants, roles, invites, classified error taxonomy | [zitadel](./docs/zitadel.md) |

## Migrating from the split packages

This package supersedes five formerly separate packages. Imports map 1:1:

| Before | After |
|---|---|
| `@octabits-io/foundation/<module>` | `@octabits-io/framework/<module>` |
| `@octabits-io/elysia` | `@octabits-io/framework/elysia` |
| `@octabits-io/elysia/mcp` | `@octabits-io/framework/elysia/mcp` |
| `@octabits-io/queue` | `@octabits-io/framework/queue` |
| `@octabits-io/storage` (+ `/s3`, `/postgres`) | `@octabits-io/framework/storage` (+ `/s3`, `/postgres`) |
| `@octabits-io/mail` (+ `/smtp`, `/mailjet`, `/brevo`) | `@octabits-io/framework/mail` (+ `/smtp`, `/mailjet`, `/brevo`) |

The wide `foundation` peer dependency the split packages declared is gone — the base
modules ship in this package.

The durable DAG workflow engine [`@octabits-io/flow`](https://github.com/octabits-io/flow)
remains a separate, standalone package by design.

## Development

```bash
pnpm build             # tsdown
pnpm typecheck         # tsc --noEmit
pnpm lint              # module-boundary check (scripts/check-boundaries.mjs)
pnpm test:unit         # fast, no Docker
pnpm test:integration  # queue against real Postgres via testcontainers (Docker required)
```

## License

MIT — see [LICENSE](./LICENSE). Vendored third-party code is listed in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
