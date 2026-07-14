# @octabits-io/platform

Monorepo for shared platform libraries. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/repo).

## Packages

| Package | Description |
|---|---|
| [`framework`](./packages/framework) | Opinionated server framework toolkit behind granular subpaths: Result types, IoC container, structured logger, config-schema fragments, RBAC, JWT/API-key auth, scoped signing, Vault secret loader, captcha contract (+ ALTCHA), PII encryption, Drizzle ORM helpers (`/drizzle/*`), iCal ingestion, Elysia middleware & MCP harness (`/elysia`), pg-boss queue base (`/queue`), namespaced blob storage (`/storage`), and mail transport + dispatch (`/mail`) |
| [`nuxt-ui-kit`](./packages/nuxt-ui-kit) | Frontend kit for Nuxt/Vue admin SPAs: OIDC session harness, auth/org store cores, route-guard builder, Eden Treaty client factory, confirm/date/AI-review components (source-shipped SFCs), date + AI-workflow engines behind subpaths |

`framework` supersedes the former `@octabits-io/{foundation,elysia,queue,storage,mail}`
packages (merged 2026-07-14; imports map 1:1 — see the
[migration table](./packages/framework/README.md#migrating-from-the-split-packages)).

The durable DAG workflow engine `@octabits-io/flow` lives in its own repository:
[octabits-io/flow](https://github.com/octabits-io/flow) (extracted from this monorepo 2026-07-14).

## Getting Started

```sh
pnpm install
```

## Scripts

```sh
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # Type-check all packages
pnpm lint        # Package lint tasks (framework's module-boundary check)
pnpm clean       # Remove all build artifacts and node_modules
```

Integration tests (framework's queue module) run against real Postgres via Testcontainers — Docker must be running.

## Versioning for consumers

These packages are pre-1.0 and managed with Changesets. A caret range on a `0.x`
package (`^0.9.0`) resolves to `>=0.9.0 <0.10.0`, so it will **not** auto-pull the
next minor. Each release needs a deliberate bump on the consumer side.

Everything heavy in `framework` is an optional peer dependency — install only the
vendor SDKs for the modules you use (`elysia`, `pg-boss`, `drizzle-orm`, `pg`,
`@aws-sdk/client-s3`, `nodemailer`, …). `zod` is the one required peer.

## License

MIT
