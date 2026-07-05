# @octabits-io/platform

Monorepo for shared platform libraries. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/repo).

## Packages

| Package | Description |
|---|---|
| [`foundation`](./packages/foundation) | Core utilities: Result types, IoC container, structured logger, config-schema fragments, RBAC engine, OIDC/JWT validation |
| [`pii`](./packages/pii) | PII encryption (age/X25519), blind indexes, master key provider |
| [`drizzle-toolkit`](./packages/drizzle-toolkit) | Drizzle ORM utilities: DB error handling, pagination, factory, migration runner, scoped CRUD, RLS scoping, idempotency, multi-tenant schema primitives (`./tenant`) |
| [`elysia`](./packages/elysia) | Elysia middleware & helpers: security headers, client IP, error mapping, response schemas, rate limiting, health routes, MCP harness |
| [`queue`](./packages/queue) | pg-boss queue base: lifecycle/monitoring facade + queue/worker/DLQ trio with Zod-validated payloads |
| [`storage`](./packages/storage) | Namespaced blob storage contract; S3-compatible and Postgres providers behind subpaths |
| [`mail`](./packages/mail) | Provider-agnostic mail transport contract; SMTP/Mailjet/Brevo transports behind per-provider subpaths |
| [`captcha`](./packages/captcha) | Provider-agnostic captcha contract; ALTCHA proof-of-work implementation + dev/test no-op |
| [`vault`](./packages/vault) | Boot-time HashiCorp Vault secret loader (KV-v2, manifest-driven, no SDK) |
| [`flow`](./packages/flow) | Durable DAG workflow engine: Zod-typed steps over Postgres + pg-boss, optional AI add-on |

> The former `schema` package was merged into `drizzle-toolkit` as the
> `./tenant` subpath; the former `drizzle-test` package was removed.

## Getting Started

```sh
pnpm install
```

## Scripts

```sh
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # Type-check all packages
pnpm clean       # Remove all build artifacts and node_modules
```

## License

MIT
