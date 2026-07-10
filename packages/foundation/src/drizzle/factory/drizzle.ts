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
 * Exported as a low-level primitive so callers that build their own Drizzle
 * instance can opt into the same augmentation (and so it can be unit-tested in
 * isolation without a live database).
 */
export function augmentDrizzle<TSchema extends AnySchema, T extends object>(
  d: T,
  schema: TSchema,
): T & { tables: TSchema; schema: TSchema } {
  const augmented = d as T & { tables: TSchema; schema: TSchema };
  augmented.tables = schema;
  augmented.schema = schema;

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
 * Augmented Drizzle instance: adds `.tables` / `.schema` references to the
 * schema module, and overrides `.transaction()` so the tx passed into the
 * callback is itself an `AppDatabase` (and thus also augmented). The runtime
 * counterpart is `augmentDrizzle`, which wraps `.transaction()` so the runtime
 * invariant matches this type.
 */
export type AppDatabase<TSchema extends AnySchema> = Omit<
  BaseDrizzle<TSchema>,
  'transaction'
> & {
  tables: TSchema;
  schema: TSchema;
  transaction: <T>(
    callback: (tx: AppDatabase<TSchema>) => Promise<T>,
    config?: BaseTransactionConfig<TSchema>,
  ) => Promise<T>;
};

/**
 * Transaction context from `db.transaction()` callback. Structurally identical
 * to `AppDatabase` for our usage (Drizzle's PgTransaction extends PgDatabase),
 * so we alias it here to keep call sites that need the `tx` semantics readable.
 */
export type AppTransaction<TSchema extends AnySchema> = AppDatabase<TSchema>;

/** Either db instance or transaction — kept as a named alias for source-compat
 *  with services that opt into cross-service transactions via an optional `tx?`. */
export type DbOrTransaction<TSchema extends AnySchema> = AppDatabase<TSchema>;

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
