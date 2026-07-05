# @octabits-io/drizzle-toolkit

Shared Drizzle ORM utilities for PostgreSQL: database error handling, pagination,
a drizzle factory, a migration runner, generic CRUD service factories, RLS
scoping, an idempotency-key store, and generic multi-tenant schema primitives.

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

Drizzle instance factory over a pre-built `pg.Pool`, with schema augmentation
(`db.tables.*` / `db.schema.*`) and a `.transaction()` whose callback receives
an equally-augmented instance.

```ts
import { Pool } from 'pg';
import { createDrizzle } from '@octabits-io/drizzle-toolkit/factory';

const pool = new Pool({ connectionString, max: 20 });
const db = createDrizzle(schema, { pool }); // optional: logger
```

Also exported: `createDrizzleFromClient` (single `PoolClient` — for
request-scoped connections carrying session vars, e.g. RLS) and
`augmentDrizzle` (wrap an existing instance).

### `@octabits-io/drizzle-toolkit/migrate`

Migration runner for Drizzle SQL migrations.

```ts
import { runMigrations } from '@octabits-io/drizzle-toolkit/migrate';

await runMigrations({ connectionString, migrationsFolder });
// optional: ssl, logger, sessionVars (GUCs set before migrate — e.g. RLS system mode)
```

### `@octabits-io/drizzle-toolkit/tenant`

Generic multi-tenant schema primitives — **column-sets** for the three base
tables a multi-tenant SaaS needs before its domain tables:

| Column-set                   | Purpose                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `baseTenantColumns`          | The tenant root — generic columns only (`id`, `name`, `isDisabled`, `createdAt`). |
| `tenantEncryptionKeyColumns` | Per-tenant PII encryption material (Age recipient + encrypted identity + blind-index key). Pairs with [`@octabits-io/pii`](../pii) — skip it if you don't use that package. |
| `tenantConfigColumns`        | Per-tenant `(tenantId, key) → jsonb value` config store.          |

Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.

Spread a column-set into your own `pgTable(...)` (the documented Drizzle
["reuse common column definitions"](https://orm.drizzle.team/docs/sql-schema-declaration#advanced)
pattern) to extend the base with domain columns. The tables, constraints, and
relations stay in *your* schema — the module ships no `pgTable` instances, so
your migrations never depend on a library-defined table:

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

Exports: `bytea` (custom `bytea ↔ Buffer` column type) and the three
column-sets (`baseTenantColumns`, `tenantEncryptionKeyColumns`,
`tenantConfigColumns`).

### `@octabits-io/drizzle-toolkit/crud`

Generic CRUD service factories over any Drizzle table with an `id` column —
paginated `list` (+total), `getById`, `create`, `update`, `delete`, with
consistent keyed errors and optional `created_by`/`updated_by` audit stamping:

- `createBaseCrudService` — no scoping.
- `createScopedCrudService` — every query auto-ANDed with
  `eq(table[scope.column], scope.value)`; `create()` injects the scope column.
  Row isolation holds by construction (`scope: { column, value }`).
- `createBaseTenantScopedCrudService` — the multi-tenant preset
  (`scope: { column: 'tenantId', value: tenantId }`).

### `@octabits-io/drizzle-toolkit/rls`

Postgres row-level-security scoping, generic over the GUC key set:
`createTenantDb(rawDb, gucs)` (per-call-transaction proxy — every top-level
operation runs inside a short transaction that applies transaction-local
`set_config(name, value, true)` first; PgBouncer-safe), `runWithGucs`,
`withSystemMode`, the pinned-connection `acquireScopedClient` /
`releaseScopedClient`, and `endPoolGracefully`. Policies and concrete GUC
values stay in the consumer.

### `@octabits-io/drizzle-toolkit/idempotency`

Stripe-style `X-Idempotency-Key` store: `createIdempotencyService` —
`begin()` → cached / fresh (`.commit(status, body)`) / conflict, TTL expiry,
request-hash matching, race-safe unique-violation handling, opportunistic
cleanup. Scoping is optional (`tenantId?`); ships a spreadable
`idempotencyKeyColumns` column-set.

> **Note:** `./tenant` absorbed the former standalone `@octabits-io/schema`
> package. The former `./testing` module (testcontainers helpers, ex
> `@octabits-io/drizzle-test`) was removed — it had no consumers; copy it from
> git history if you need it.
> The former `./workflow` module (DAG workflow engine) has been superseded by
> [`@octabits-io/flow`](../flow) — a standalone durable workflow engine with a
> Postgres store and pg-boss dispatcher. Use that package instead.

## License

MIT
