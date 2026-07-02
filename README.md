# @octabits-io/platform

Monorepo for shared platform libraries. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/repo).

## Packages

| Package | Description |
|---|---|
| [`foundation`](./packages/foundation) | Core utilities: Result types, IoC container, structured logger, and helpers |
| [`pii`](./packages/pii) | PII encryption (age/X25519), blind indexes, master key provider |
| [`drizzle-toolkit`](./packages/drizzle-toolkit) | Drizzle ORM utilities: DB error handling and pagination |
| [`drizzle-test`](./packages/drizzle-test) | Integration test helpers: Testcontainers + Drizzle setup and isolation |
| [`flow`](./packages/flow) | Durable DAG workflow engine: Zod-typed steps over Postgres + pg-boss, optional AI add-on |

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
