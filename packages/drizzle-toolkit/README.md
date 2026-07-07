# @octabits-io/drizzle-toolkit

Shared Drizzle ORM utilities for PostgreSQL: database error handling, pagination,
a drizzle factory, a migration runner, generic CRUD service factories, a
scoped config store, RLS scoping, an idempotency-key store, and generic scope
schema primitives.

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

### `@octabits-io/drizzle-toolkit/scope`

Generic schema primitives for a **scope-owner** root plus per-scope keys and
config — **column-sets** for three common base tables. A "scope" is whatever
partitions your app (a tenant, workspace, organization, project, or nothing at
all when single-tenant); the scope-reference column is **yours to declare**.

| Column-set              | Purpose                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `baseScopeColumns`      | The scope-owner root — generic columns only (`id`, `name`, `isDisabled`, `createdAt`). |
| `encryptionKeyColumns`  | Per-scope PII encryption material (Age recipient + encrypted identity + blind-index key). Pairs with [`@octabits-io/pii`](../pii) — skip it if you don't use that package. |
| `scopedConfigColumns`   | Key/value config columns (`key`, `value` jsonb, `encrypted`, audit) — add your own scope column and a `(scopeColumn, key)` PK. |

Only `drizzle-orm/pg-core` primitives are used — no framework or app imports.

Spread a column-set into your own `pgTable(...)` (the documented Drizzle
["reuse common column definitions"](https://orm.drizzle.team/docs/sql-schema-declaration#advanced)
pattern) to extend the base with domain columns. The tables, constraints, and
relations stay in *your* schema — the module ships no `pgTable` instances, so
your migrations never depend on a library-defined table. The
`encryptionKeyColumns` / `scopedConfigColumns` sets deliberately omit the scope
column so you own its name, type, FK, and PK placement:

```ts
import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";
import { baseScopeColumns, scopedConfigColumns } from "@octabits-io/drizzle-toolkit/scope";

// Extend the scope-owner root with your domain columns (name it what you like):
export const tenant = pgTable("tenant", {
  ...baseScopeColumns, // id, name, isDisabled, createdAt
  region: text("region").notNull(),
  seatLimit: integer("seat_limit"),
});

// Add your scope column and declare the composite PK in the constraints callback:
export const tenantConfig = pgTable(
  "tenant_config",
  {
    ...scopedConfigColumns,
    tenantId: text("tenant_id").notNull(), // your scope column
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key], name: "tenant_config_pk" })],
);
```

Exports: `bytea` (custom `bytea ↔ Buffer` column type) and the three
column-sets (`baseScopeColumns`, `encryptionKeyColumns`, `scopedConfigColumns`).

### `@octabits-io/drizzle-toolkit/crud`

Generic CRUD service factories over any Drizzle table with an `id` column —
paginated `list` (+total), `getById`, `create`, `update`, `delete`, with
consistent keyed errors and optional `created_by`/`updated_by` audit stamping:

- `createBaseCrudService` — no scoping.
- `createScopedCrudService` — every query auto-ANDed with
  `eq(table[scope.column], scope.value)`; `create()` injects the scope column.
  Row isolation holds by construction (`scope: { column, value }`) — bind
  whatever column partitions your app (`{ column: 'tenantId', value }`,
  `{ column: 'workspaceId', value }`, …).

### `@octabits-io/drizzle-toolkit/config`

Generic **config store** over any key/value table (spread
`scopedConfigColumns` from `./scope`): the validate → encrypt → cache →
default engine. Scoping is **optional**, mirroring `./crud`'s base-vs-scoped
split — no tenant vocabulary in the core.

- `createScopedConfigService` — `writeConfig` validates each `{ key, value }`
  through a caller-supplied `schema`, ciphers `encryptedKeys` into a
  `{ __encrypted: <base64> }` envelope, and upserts every entry in one
  statement; `readConfig(...keys)` / `readAll()` decrypt, re-validate (so **Zod
  defaults apply** for absent rows), and cache. Generic over the caller's
  key→value map. Pass a `{ column, value }` `scope` to partition rows (conflict
  target `(scopeColumn, key)`); **omit `scope`** for an unscoped single-tenant
  store (conflict target `(key)`). The conflict target must match the table's
  primary key.
- Encryption is an injected `cipher` (raw-string `encrypt`/`decrypt`) — no
  `@octabits-io/pii` dependency; the engine owns the envelope + JSON. A
  `readConfig` on an undecryptable `encrypted=true` row **throws**
  `ScopedConfigDecryptError` rather than silently falling back to a default.
- `createScopedConfigCache` builds the optional cross-scope cache over a
  foundation `LruCache`, gated by `cacheableKeys` (transactional keys are never
  cached); `readConfig` also keeps a request-scoped cache, both invalidated on
  write.

### `@octabits-io/drizzle-toolkit/rls`

Postgres row-level-security scoping, generic over the GUC key set:
`createScopedDb(rawDb, gucs)` (per-call-transaction proxy — every top-level
operation runs inside a short transaction that applies transaction-local
`set_config(name, value, true)` first; PgBouncer-safe), `runWithGucs`,
`withSystemMode`, the pinned-connection `acquireScopedClient` /
`releaseScopedClient`, and `endPoolGracefully`. Policies and concrete GUC
values stay in the consumer.

### `@octabits-io/drizzle-toolkit/idempotency`

Stripe-style `X-Idempotency-Key` store: `createIdempotencyService` —
`begin()` → cached / fresh (`.commit(status, body)`) / conflict, TTL expiry,
request-hash matching, race-safe unique-violation handling, opportunistic
cleanup. Scoping is optional (`scope?: { column, value }`); ships a spreadable
`idempotencyKeyColumns` column-set (add your own scope column when scoping).

> **Note:** `./scope` absorbed the former standalone `@octabits-io/schema`
> package. The former `./testing` module (testcontainers helpers, ex
> `@octabits-io/drizzle-test`) was removed — it had no consumers; copy it from
> git history if you need it.
> The former `./workflow` module (DAG workflow engine) has been superseded by
> [`@octabits-io/flow`](../flow) — a standalone durable workflow engine with a
> Postgres store and pg-boss dispatcher. Use that package instead.

## License

MIT
