import { drizzle } from 'drizzle-orm/node-postgres';
import { types, type Pool, type PoolClient } from 'pg';
import type { Logger } from 'drizzle-orm';

// Raw db.execute() bypasses Drizzle's { mode: "number" } column mapping, and pg
// returns int8 (incl. COUNT(*)) as string to guard against precision loss above
// 2^53. App schemas that assume ids fit in a double want int8 parsed as number
// everywhere. NUMERIC (OID 1700) intentionally stays string.
//
// Applied lazily (and idempotently) inside the factory functions rather than at
// module load: importing this module must not mutate pg's global parser
// registry as a side effect, and under pg version skew (two pg copies in the
// tree) a load-time call could silently register on the wrong copy — the one
// the consumer's Pool never uses.
let int8ParserConfigured = false;
function ensureInt8Parser(): void {
  if (int8ParserConfigured) return;
  types.setTypeParser(types.builtins.INT8, Number);
  int8ParserConfigured = true;
}

/** Any Drizzle schema module — a record of table/relation definitions. */
export type AnySchema = Record<string, unknown>;

export interface CreateDrizzleOptions {
  pool: Pool;
  logger?: boolean | Logger;
}

export interface CreateDrizzleFromClientOptions {
  client: PoolClient;
  logger?: boolean | Logger;
}

/**
 * Augment a Drizzle instance with `.tables` / `.schema` references and wrap
 * `.transaction()` so the tx passed into the callback also carries the same
 * augmentation. The recursive call inside the wrapper covers nested savepoints.
 *
 * `.tables` is the accessor to reach for — it is ours, and always the schema
 * module. `.schema` is a convenience alias that exists only where Drizzle does
 * not already own that field (see below).
 *
 * Exported as a low-level primitive so callers that build their own Drizzle
 * instance can opt into the same augmentation (and so it can be unit-tested in
 * isolation without a live database).
 *
 * The return type describes that intended use — a `PgDatabase`, which has no
 * `schema` of its own. It cannot describe the transaction case: Drizzle
 * declares `PgTransaction.schema` as `protected`, so it is invisible to a
 * conditional type and no signature can tell the two apart. Reach for the
 * public `AppDatabase` / `AppTransaction` aliases rather than this return type,
 * and use `.tables` for tables either way.
 */
export function augmentDrizzle<TSchema extends AnySchema, T extends object>(
  d: T,
  schema: TSchema,
): T & { tables: TSchema; schema: TSchema } {
  // Probed through `d`, not `augmented` — the cast below asserts `schema`
  // exists, which would narrow the check away to `never`.
  const drizzleOwnsSchema = 'schema' in (d as object);

  const augmented = d as T & { tables: TSchema; schema: TSchema };
  augmented.tables = schema;
  // Never clobber a `schema` Drizzle owns. `PgTransaction` keeps its
  // RelationalSchemaConfig ({ fullSchema, schema, tableNamesMap }) there, and
  // its nested `.transaction()` feeds exactly that field to the savepoint tx's
  // constructor — overwriting it with the raw schema module leaves the nested
  // tx with no relational config and an empty `.query` API, so `tx.query.foo`
  // is `undefined` two levels down. `PgDatabase` keeps its config on `_` and
  // has no own `schema`, so there the assignment is purely additive; that
  // asymmetry is why only the second level ever broke.
  if (!drizzleOwnsSchema) augmented.schema = schema;

  const original = (augmented as any).transaction?.bind(augmented);
  if (typeof original === 'function') {
    (augmented as any).transaction = (
      callback: (tx: any) => Promise<unknown>,
      ...rest: unknown[]
    ) =>
      original(
        (tx: any) => callback(augmentDrizzle(tx, schema)),
        ...rest,
      );
  }

  return augmented;
}

type BaseDrizzle<TSchema extends AnySchema> = ReturnType<typeof drizzle<TSchema>>;
type BaseTransactionConfig<TSchema extends AnySchema> = Parameters<
  BaseDrizzle<TSchema>['transaction']
>[1];

/**
 * What an augmented instance carries whether it is a connection or a
 * transaction: everything Drizzle exposes, plus `.tables`, plus a
 * `.transaction()` whose callback receives the same augmentation.
 *
 * `.schema` is deliberately **not** here — see `AppDatabase` below.
 */
type AugmentedDrizzle<TSchema extends AnySchema> = Omit<
  BaseDrizzle<TSchema>,
  'transaction'
> & {
  tables: TSchema;
  transaction: <T>(
    callback: (tx: AugmentedDrizzle<TSchema>) => Promise<T>,
    config?: BaseTransactionConfig<TSchema>,
  ) => Promise<T>;
};

/**
 * Augmented Drizzle instance: adds `.tables` / `.schema` references to the
 * schema module, and overrides `.transaction()` so the tx passed into the
 * callback is itself augmented. The runtime counterpart is `augmentDrizzle`,
 * which wraps `.transaction()` so the runtime invariant matches this type.
 *
 * `.schema` is declared **only here**, on the connection, because that is the
 * only place `augmentDrizzle` sets it: on a transaction Drizzle already owns
 * that field (its `RelationalSchemaConfig`) and the factory leaves it alone, so
 * nested transactions keep their relational query API. Declaring it on the
 * shared shape would make `tx.schema` compile and hand back something that is
 * not the schema module.
 *
 * **`.tables` is the accessor to reach for.** It is the factory's own field and
 * is the schema module on a connection and a transaction alike.
 */
export type AppDatabase<TSchema extends AnySchema> = AugmentedDrizzle<TSchema> & {
  schema: TSchema;
};

/**
 * Transaction context from `db.transaction()` callback.
 *
 * `AppDatabase` minus `.schema` — Drizzle's `PgTransaction` declares its own
 * `schema` as `protected`, so a transaction has no publicly readable one, and
 * claiming otherwise is how `tx.schema.someTable` used to typecheck and return
 * `undefined`. An `AppDatabase` is still assignable here; the reverse is not,
 * which is the point.
 */
export type AppTransaction<TSchema extends AnySchema> = AugmentedDrizzle<TSchema>;

/** Either db instance or transaction — kept as a named alias for source-compat
 *  with services that opt into cross-service transactions via an optional `tx?`.
 *  Deliberately the *weaker* of the two, so it accepts both and promises only
 *  what both actually have. */
export type DbOrTransaction<TSchema extends AnySchema> = AppTransaction<TSchema>;

/** Create an augmented Drizzle instance backed by a connection Pool. */
export function createDrizzle<TSchema extends AnySchema>(
  schema: TSchema,
  opts: CreateDrizzleOptions,
): AppDatabase<TSchema> {
  ensureInt8Parser();
  const d = drizzle({
    client: opts.pool,
    logger: opts.logger,
    schema,
  });

  return augmentDrizzle(d, schema) as unknown as AppDatabase<TSchema>;
}

/**
 * Create an augmented Drizzle instance backed by a single PoolClient connection.
 * Used for request-scoped database access where the connection has been
 * configured with session variables (SET ROLE, set_config) — e.g. RLS.
 */
export function createDrizzleFromClient<TSchema extends AnySchema>(
  schema: TSchema,
  opts: CreateDrizzleFromClientOptions,
): AppDatabase<TSchema> {
  ensureInt8Parser();
  const d = drizzle({
    client: opts.client,
    logger: opts.logger,
    schema,
  });

  // Cast through unknown because Drizzle's $client type differs (PoolClient vs
  // Pool) but the query interface is identical for our usage.
  return augmentDrizzle(d, schema) as unknown as AppDatabase<TSchema>;
}
