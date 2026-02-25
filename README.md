# @octabits-io/platform

Monorepo for shared platform libraries. Managed with [pnpm workspaces](https://pnpm.io/workspaces) and [Turborepo](https://turbo.build/repo).

## Packages

| Package | Description |
|---|---|
| [`foundation`](./foundation) | Core utilities: Result types, IoC container, structured logger, and helpers |
| [`pii`](./pii) | PII encryption (age/X25519), blind indexes, master key provider |
| [`drizzle-toolkit`](./drizzle-toolkit) | Drizzle ORM utilities: DB error handling, pagination, DAG workflow engine |
| [`drizzle-test`](./drizzle-test) | Integration test helpers: Testcontainers + Drizzle setup and isolation |

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
