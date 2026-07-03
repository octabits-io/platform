# @octabits-io/drizzle-toolkit

Shared Drizzle ORM utilities for PostgreSQL: database error handling, pagination,
a drizzle factory, a migration runner, generic multi-tenant schema primitives,
and testcontainers-backed test utilities.

## Modules

### `@octabits-io/drizzle-toolkit/db`

Database error handling and pagination helpers.

```ts
import {
  withDbErrorHandling,
  handleTransactionError,
  TransactionRollbackError,
  normalizePaginationLimit,
} from '@octabits-io/drizzle-toolkit/db';

// Wrap DB operations — catches PG errors and returns Result<T, E | OctDatabaseError>
const result = await withDbErrorHandling(async () => {
  await db.insert(users).values({ email });
  return { ok: true, value: undefined };
});
// result.error.code → 'unique_violation' | 'foreign_key_violation' | ...

// Inside transactions — preserve typed errors through rollback
try {
  await db.transaction(async (tx) => {
    const result = await paymentService.create(tenantId, params, tx);
    if (!result.ok) throw new TransactionRollbackError(result.error);
  });
} catch (error) {
  return handleTransactionError(error); // preserves typed error or maps PG error
}

// Pagination: limit=-1 → capped at 10,000
const dbLimit = normalizePaginationLimit(params.limit);
```

### `@octabits-io/drizzle-toolkit/factory`

Drizzle instance factory with pool configuration and schema augmentation
(`db.tables.*`).

```ts
import { createDrizzle } from '@octabits-io/drizzle-toolkit/factory';

const db = createDrizzle({ url, schema, poolMax: 20 });
```

### `@octabits-io/drizzle-toolkit/migrate`

Migration runner for Drizzle SQL migrations.

```ts
import { runMigrations } from '@octabits-io/drizzle-toolkit/migrate';

await runMigrations({ databaseUrl, migrationsFolder });
```

### `@octabits-io/drizzle-toolkit/tenant`

Generic multi-tenant schema primitives — the three base tables a multi-tenant
SaaS needs before its domain tables:

| Table                  | Purpose                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| `tenant`               | The tenant root — generic columns only (`id`, `name`, `isDisabled`, `createdAt`). |
| `tenantEncryptionKey`  | Per-tenant PII encryption material (Age recipient + encrypted identity + blind-index key). Pairs with [`@octabits-io/pii`](../pii) — skip it if you don't use that package. |
| `tenantConfig`         | Per-tenant `(tenantId, key) → jsonb value` config store.          |

Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.

Two ways to consume — ready-built tables, or **column-sets** you spread into
your own `pgTable(...)` (the documented Drizzle
["reuse common column definitions"](https://orm.drizzle.team/docs/sql-schema-declaration#advanced)
pattern) to extend the base with domain columns:

```ts
import { pgTable, text, integer, foreignKey } from "drizzle-orm/pg-core";
import { baseTenantColumns, tenantConfigColumns } from "@octabits-io/drizzle-toolkit/tenant";

// Extend `tenant` with your domain columns:
export const tenant = pgTable("tenant", {
  ...baseTenantColumns, // id, name, isDisabled, createdAt
  region: text("region").notNull(),
  seatLimit: integer("seat_limit"),
});

// The config / encryption-key column-sets omit the FK + composite PK, since
// those depend on *your* tenant table — add them in the constraints callback:
export const tenantConfig = pgTable(
  "tenant_config",
  { ...tenantConfigColumns },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenant.id], name: "tenant_config_tenant_id_fk" }),
  ],
);
```

Exports: `bytea` (custom `bytea ↔ Buffer` column type), the three column-sets
(`baseTenantColumns`, `tenantEncryptionKeyColumns`, `tenantConfigColumns`), the
ready-built tables (`tenant`, `tenantEncryptionKey`, `tenantConfig`), and their
Drizzle relations.

### `@octabits-io/drizzle-toolkit/testing`

Integration test utilities: spins up a real Postgres container via
Testcontainers, runs migrations, and provides per-test isolation. Requires the
optional peers `testcontainers`, `@testcontainers/postgresql`, and `vitest`
(dev-only — install them in your app's devDependencies).

**`vitest.config.ts`:**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
  },
});
```

**`global-setup.ts`:**

```ts
import { createGlobalSetup } from '@octabits-io/drizzle-toolkit/testing';

const { setup, teardown } = createGlobalSetup({
  migrationsFolder: './drizzle/migrations',
  image: 'postgres:17-alpine', // optional, default
});

export { setup, teardown };
```

**Test file:**

```ts
import {
  setupTestDatabase,
  cleanupTestDatabase,
  resetDatabase,
  unusedService,
} from '@octabits-io/drizzle-toolkit/testing';
import * as schema from './schema';

let db: Awaited<ReturnType<typeof setupTestDatabase<typeof schema>>>;

beforeAll(async () => {
  db = await setupTestDatabase({ schema });
});

afterAll(async () => {
  await cleanupTestDatabase();
});

beforeEach(async () => {
  await resetDatabase(db, [schema.users, schema.posts]); // truncate with CASCADE
});
```

| Function | Description |
|---|---|
| `createGlobalSetup(opts)` | Creates Vitest `setup`/`teardown` hooks that start a Postgres container and run Drizzle migrations |
| `setupTestDatabase(opts)` | Connects to the container and returns a typed `NodePgDatabase<TSchema>` |
| `cleanupTestDatabase()` | Closes the connection pool |
| `resetDatabase(db, tables)` | Truncates tables with `RESTART IDENTITY CASCADE` |
| `unusedService<T>(name)` | Typed throwing-proxy stub for constructor deps a test never exercises |

> **Note:** `./tenant` and `./testing` absorbed the former standalone
> `@octabits-io/schema` and `@octabits-io/drizzle-test` packages.
> The former `./workflow` module (DAG workflow engine) has been superseded by
> [`@octabits-io/flow`](../flow) — a standalone durable workflow engine with a
> Postgres store and pg-boss dispatcher. Use that package instead.

## License

MIT
