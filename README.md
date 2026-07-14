# @octabits-io/platform

Monorepo for shared platform libraries. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/repo).

## Packages

| Package | Description |
|---|---|
| [`foundation`](./packages/foundation) | Base utilities: Result types, IoC container, structured logger, config-schema fragments, RBAC, JWT/API-key auth, scoped signing, Vault secret loader, captcha contract (+ ALTCHA), PII encryption, Drizzle ORM helpers (`./drizzle/*`), iCal ingestion |
| [`flow`](./packages/flow) | Durable DAG workflow engine: Zod-typed steps, retries, durable sleep, fan-out, signals, sagas; Postgres store and pg-boss dispatcher behind subpaths, optional AI add-on |
| [`elysia`](./packages/elysia) | Elysia middleware & helpers: security headers, client IP, error mapping, response schemas, rate limiting, health routes, app skeleton, MCP harness (`./mcp`) |
| [`queue`](./packages/queue) | pg-boss queue base: lifecycle/monitoring facade + declarative queue/worker/DLQ trio with Zod-validated payloads |
| [`storage`](./packages/storage) | Namespaced blob storage contract; S3-compatible and Postgres providers behind subpaths |
| [`mail`](./packages/mail) | Provider-agnostic mail transport contract + transactional dispatch layer; SMTP/Mailjet/Brevo transports behind per-provider subpaths |
| [`nuxt-ui-kit`](./packages/nuxt-ui-kit) | Frontend kit for Nuxt/Vue admin SPAs: OIDC session harness, auth/org store cores, route-guard builder, Eden Treaty client factory, confirm/date/AI-review components (source-shipped SFCs), date + AI-workflow engines behind subpaths |


## Getting Started

```sh
pnpm install
```

## Scripts

```sh
pnpm build       # Build all packages
pnpm test        # Run all tests
pnpm typecheck   # Type-check all packages
pnpm lint        # Package lint tasks (currently flow's layer-boundary check)
pnpm clean       # Remove all build artifacts and node_modules
```

Integration tests (flow, queue) run against real Postgres via Testcontainers — Docker must be running.

## Versioning for consumers

These packages are pre-1.0 and managed with Changesets. All packages version
**independently**. Two things to know when depending on them:

- A caret range on a `0.x` package (`^0.9.0`) resolves to `>=0.9.0 <0.10.0`, so
  it will **not** auto-pull the next minor. Each release needs a deliberate
  bump on the consumer side.
- `elysia`, `queue`, `storage`, and `mail` declare `@octabits-io/foundation` as
  a **wide peer** (`>=0.2.0 <1`) because its `Result`/`OctError`/`Logger` types
  appear in their public APIs. Install `foundation` yourself; as long as your
  own range admits it, a single instance is resolved. `flow` is standalone and
  has no dependency on `foundation`.

## License

MIT
