/**
 * RLS request/system scoping helpers (#32) — the primitives that make
 * Postgres row-level security work per request:
 *
 * - `createScopedDb(rawDb, gucs)` — a Drizzle proxy that wraps every top-level
 *   operation in a short transaction whose first statement is
 *   `set_config(name, value, true)` (transaction-local, PgBouncer-safe).
 * - `runWithGucs` / `withSystemMode` — one-shot scoped transactions.
 * - `acquireScopedClient` / `releaseScopedClient` — the pinned-connection
 *   model (BEGIN at scope acquire, COMMIT/ROLLBACK at dispose).
 * - `endPoolGracefully` — pool drain with a hard timeout for SIGTERM.
 *
 * Fully generic over the GUC key set — the GUC names (e.g. `app.tenant_id` or
 * `app.scope_key`, plus `app.system_mode`) are just string keys the consumer
 * passes. RLS *policies* live in the consumer's SQL migrations; the concrete
 * GUC values are set by the consumer's IoC scope factories.
 */
import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import type { Logger as DrizzleLogger } from 'drizzle-orm';
import { ServiceLifetime } from '../../ioc/index.ts';

/**
 * GUC key/value pairs applied via `set_config(name, value, true)` at the
 * start of every wrapped transaction. `true` = transaction-local.
 */
export type SessionVars = Record<string, string>;

/**
 * Minimal structural view of an (augmented) Drizzle instance for RLS
 * wrapping. Transactions are structurally identical to the db (the `./factory`
 * augmentation rewraps them), so `TDb` stands in for both.
 */
export interface RlsDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(...args: any[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: Record<string, any>;
}

/**
 * Methods that need auto-wrap: each call should run inside a per-call
 * transaction with the configured GUCs applied. The deferred-builder proxy
 * collects the chain (`.from`, `.where`, …) and only opens a transaction when
 * the chain is awaited.
 *
 * IMPORTANT: every top-level Drizzle query-builder entry point must be listed
 * here. Anything missing falls through to the raw `db` object and runs
 * *without* the GUCs — meaning the scope GUC is unset and RLS policies that
 * compare against `current_setting(..., true)` silently match zero rows.
 */
export const QUERY_BUILDER_METHODS = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  // CTE entry point (`db.with(...ctes).select()…`) — the chain executes SQL
  // when awaited, so it must replay inside the GUC transaction like the rest.
  'with',
  // `db.$count(table, filter?)` is awaitable like a select.
  '$count',
  'refreshMaterializedView',
]);

/**
 * Synchronous builder APIs that cannot work on the deferred-replay proxy: they
 * must return a concrete value *now*, but the proxy only executes the recorded
 * chain (inside the GUC transaction) when it is awaited. Accessing one of these
 * throws a clear error instead of silently handing back a recorder proxy.
 * Use `runWithGucs(db, gucs, (tx) => …)` for chains that need them.
 */
const UNSUPPORTED_SYNC_BUILDER_METHODS = new Set(['toSQL', 'getSQL', 'prepare', 'as']);

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

/**
 * Run `fn` inside a transaction on `rawDb`, with `gucs` applied via
 * transaction-local `set_config(...)` first. The `tx` passed to `fn` is the
 * raw transaction-bound Drizzle (already augmented by the factory) so `fn`
 * can use it as a normal db/transaction without further proxying.
 */
export async function runWithGucs<TDb extends RlsDatabase, T>(
  rawDb: TDb,
  gucs: SessionVars,
  fn: (tx: TDb) => Promise<T>,
): Promise<T> {
  return rawDb.transaction(async (tx) => {
    for (const [name, value] of Object.entries(gucs)) {
      await (tx as RlsDatabase).execute(sql`select set_config(${name}, ${value}, true)`);
    }
    return fn(tx as TDb);
  });
}

/**
 * Lazy thenable that records a Drizzle query-builder chain (e.g.
 * `db.select().from(t).where(...)`), and only opens a transaction when the
 * chain is awaited. The transaction sets GUCs first, then re-runs the
 * recorded chain against the transaction-bound Drizzle.
 *
 * The result is cached so awaiting twice doesn't run the query twice.
 */
function createDeferredBuilder<TDb extends RlsDatabase>(
  rawDb: TDb,
  gucs: SessionVars,
  initialMethod: string,
  initialArgs: unknown[],
): unknown {
  type Call = { method: string; args: unknown[] };
  const calls: Call[] = [{ method: initialMethod, args: initialArgs }];

  let cached: Promise<unknown> | undefined;
  const exec = (): Promise<unknown> => {
    if (cached) return cached;
    cached = runWithGucs(rawDb, gucs, async (tx) => {
      let cursor: unknown = tx;
      for (const { method, args } of calls) {
        const fn = (cursor as AnyRecord)[method];
        if (typeof fn !== 'function') {
          throw new TypeError(
            `scopedDb: cannot replay '${method}' on tx — not a function`,
          );
        }
        cursor = (fn as AnyFn).apply(cursor, args);
      }
      return await (cursor as Promise<unknown>);
    });
    return cached;
  };

  function makeProxy(): unknown {
    return new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) => exec().then(onFulfilled, onRejected);
        }
        if (prop === 'catch') {
          return (onRejected?: (e: unknown) => unknown) => exec().catch(onRejected);
        }
        if (prop === 'finally') {
          return (onFinally?: () => void) => exec().finally(onFinally);
        }
        if (typeof prop === 'symbol') return undefined;
        if (UNSUPPORTED_SYNC_BUILDER_METHODS.has(prop)) {
          throw new TypeError(
            `scopedDb: '${prop}' is a synchronous builder API and cannot run on the ` +
              `deferred GUC-scoped proxy (the chain only executes when awaited). ` +
              `Use runWithGucs(db, gucs, (tx) => ...) and call '${prop}' on the ` +
              `transaction-bound builder instead.`,
          );
        }
        // Record the next call in the chain and return another proxy.
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return makeProxy();
        };
      },
    });
  }

  return makeProxy();
}

/**
 * Wrap the relational query namespace (`db.query.tableName.findFirst/Many`)
 * so each terminal call runs inside a transaction with GUCs applied.
 */
function createQueryNamespaceProxy<TDb extends RlsDatabase>(
  rawDb: TDb,
  gucs: SessionVars,
  rawNamespace: TDb['query'],
): TDb['query'] {
  return new Proxy(rawNamespace as unknown as AnyRecord, {
    get(target, tableNameProp) {
      if (typeof tableNameProp !== 'string') {
        return (target as Record<PropertyKey, unknown>)[tableNameProp];
      }
      const tableName = tableNameProp;
      const tableQueries = target[tableName];
      if (!tableQueries || typeof tableQueries !== 'object') {
        return tableQueries;
      }
      return new Proxy(tableQueries as AnyRecord, {
        get(t, methodNameProp) {
          if (typeof methodNameProp !== 'string') {
            return (t as Record<PropertyKey, unknown>)[methodNameProp];
          }
          const methodName = methodNameProp;
          const original = t[methodName];
          if (typeof original !== 'function') return original;
          if (methodName === 'findFirst' || methodName === 'findMany') {
            return (...args: unknown[]) =>
              runWithGucs(rawDb, gucs, async (tx) => {
                const txQuery = tx.query as unknown as Record<string, AnyRecord>;
                const txTable = txQuery[tableName];
                const fn = txTable?.[methodName];
                if (typeof fn !== 'function') {
                  throw new TypeError(
                    `scopedDb: tx.query.${tableName}.${methodName} is not a function`,
                  );
                }
                return await (fn as AnyFn).apply(txTable, args);
              });
          }
          return (original as AnyFn).bind(t);
        },
      });
    },
  }) as unknown as TDb['query'];
}

/**
 * Build a scope-bound Drizzle proxy. Top-level query methods auto-wrap each
 * call in a short transaction with `gucs` applied via `set_config(_, _, true)`.
 * `db.transaction(fn)` and `db.execute(...)` are also wrapped. Everything
 * else passes through to the underlying `rawDb`.
 *
 * The proxy is shaped exactly like the input db from the consumer's POV, so
 * existing service code works unchanged.
 */
export function createScopedDb<TDb extends RlsDatabase>(
  rawDb: TDb,
  gucs: SessionVars,
): TDb {
  // Cache the wrapped query namespace so repeat accesses return the same proxy.
  let queryNs: TDb['query'] | undefined;

  return new Proxy(rawDb as unknown as object, {
    get(target, prop, receiver) {
      const rd = target as unknown as TDb;

      // Override transaction: set GUCs at the start, then hand `tx` to the user.
      if (prop === 'transaction') {
        return <T,>(callback: (tx: TDb) => Promise<T>) =>
          runWithGucs(rd, gucs, callback);
      }

      if (typeof prop === 'string') {
        // `$with` never executes SQL — it only builds a CTE alias
        // (`db.$with('sq').as(qb)`) that is later passed to `with(...)`. Hand
        // it straight to the raw db, bound so internal `this` access does not
        // re-enter this proxy.
        if (prop === '$with') {
          const fn = Reflect.get(target, prop) as AnyFn | undefined;
          return typeof fn === 'function' ? fn.bind(target) : fn;
        }

        // Wrap top-level builder entries (select/insert/update/delete/with/…).
        if (QUERY_BUILDER_METHODS.has(prop)) {
          return (...args: unknown[]) =>
            createDeferredBuilder(rd, gucs, prop, args);
        }

        // Wrap execute(): always runs inside the wrapped tx.
        if (prop === 'execute') {
          return (...args: unknown[]) =>
            runWithGucs(rd, gucs, async (tx) =>
              (tx.execute as AnyFn).apply(tx, args),
            );
        }

        // Wrap the relational-query namespace.
        if (prop === 'query') {
          if (!queryNs) {
            queryNs = createQueryNamespaceProxy(rd, gucs, rd.query);
          }
          return queryNs;
        }
      }

      // Pass-through for tables/schema/$client and anything else.
      return Reflect.get(target, prop, receiver);
    },
  }) as TDb;
}

/**
 * Convenience: short-lived system-mode transaction — equivalent to
 * `runWithGucs(db, { [systemModeGuc]: 'true' }, fn)`. For background tasks
 * that just need to bypass RLS for a single unit of work. The GUC name
 * defaults to the conventional `app.system_mode`; override to match your
 * policies.
 */
export function withSystemMode<TDb extends RlsDatabase, T>(
  db: TDb,
  fn: (tx: TDb) => Promise<T>,
  systemModeGuc = 'app.system_mode',
): Promise<T> {
  return runWithGucs(db, { [systemModeGuc]: 'true' }, fn);
}

/**
 * Acquire a Postgres client from the pool, **begin a transaction** on it, and
 * apply per-request session variables via `set_config(name, value, true)` so
 * they live for the duration of that transaction.
 *
 * The returned `db` is built by the injected `createDb(client)` (bind your
 * schema-augmented Drizzle factory there). While the transaction is open the
 * bouncer (in transaction-pool mode) keeps the same backend assigned, so RLS
 * GUCs set via `set_config(..., true)` survive every query inside the
 * request. The transaction is COMMIT-ed (or ROLLBACK-ed) by
 * `releaseScopedClient` at scope dispose.
 *
 * If `BEGIN` or `set_config` fails (broken connection from the pool, etc.),
 * the client is destroyed and the error re-thrown — preventing a leaked
 * client when scope creation can't register a dispose hook yet.
 */
export async function acquireScopedClient<TDb>(opts: {
  pool: Pool;
  /** Session variables applied via `SELECT set_config(name, value, true)`. */
  sessionVars: Record<string, string>;
  /** Build the client-bound Drizzle (e.g. `createDrizzleFromClient` bound to your schema). */
  createDb: (client: PoolClient, logger?: boolean | DrizzleLogger) => TDb;
  logger?: boolean | DrizzleLogger;
}): Promise<{ client: PoolClient; db: TDb }> {
  const { pool, sessionVars, createDb, logger } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [name, value] of Object.entries(sessionVars)) {
      await client.query(`SELECT set_config($1, $2, true)`, [name, value]);
    }
  } catch (err) {
    // Try to roll back any partial state, then destroy the client so the bad
    // connection is not returned to the pool.
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already broken — just destroy it.
    }
    client.release(err as Error);
    throw err;
  }

  const db = createDb(client, logger);
  return { client, db };
}

/**
 * Commit (default) or roll back the request transaction, then release the
 * client back to the pool.
 *
 * - **COMMIT failure** is a real write failure: the client is released *with*
 *   the error (so pg destroys the possibly-broken connection instead of
 *   recycling it) and the error is **rethrown** — callers must not treat the
 *   request as successfully persisted.
 * - **ROLLBACK failure** is swallowed (dispose paths run during error
 *   handling and the work is being discarded anyway), but the client is still
 *   released with the error so the broken connection is destroyed.
 */
export async function releaseScopedClient(opts: {
  client: PoolClient;
  commit: boolean;
}): Promise<void> {
  const { client, commit } = opts;
  try {
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    // Release WITH the error so pg destroys the connection rather than
    // returning a client with unknown transaction state to the pool.
    client.release(err as Error);
    if (commit) throw err;
    return;
  }
  client.release();
}

/** Structural logger for shutdown messages (matches foundation's Logger). */
export interface ShutdownLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error): void;
}

/**
 * Drain a pg.Pool on graceful shutdown with a hard timeout. Existing acquired
 * clients block `pool.end()` until they're released; we cap the wait so a
 * stuck client can't keep the process alive past the SIGTERM grace period.
 */
export async function endPoolGracefully(opts: {
  pool: Pool;
  logger: ShutdownLogger;
  timeoutMs?: number;
}): Promise<void> {
  const { pool, logger, timeoutMs = 10_000 } = opts;
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs).unref(),
  );
  try {
    const result = await Promise.race([pool.end().then(() => 'ended' as const), timeout]);
    if (result === 'timeout') {
      logger.warn('pg.Pool.end() timed out, forcing exit', { timeoutMs });
    } else {
      logger.info('pg.Pool drained');
    }
  } catch (err) {
    logger.error('pg.Pool.end() threw', err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// GUC value guards + the IoC bridge
// ---------------------------------------------------------------------------

/**
 * Guard for **list-valued** GUCs. Single GUC values are parameterized safely
 * by `runWithGucs`/`createScopedDb`, but a list joined into one GUC (read
 * DB-side via `string_to_array(current_setting(...), ',')`) has an in-band
 * separator: an element containing `,` widens the match set, and `'` invites
 * quoting bugs in hand-written policies. Ids passed here are expected to be
 * machine-generated (uuids, snowflakes) — any such character is illegitimate,
 * so we reject rather than silently truncate or widen.
 *
 * Throws on the first offending value; returns nothing when all are safe.
 */
export function assertSafeGucListValue(values: readonly string[]): void {
  for (const value of values) {
    if (value.includes(',') || value.includes("'")) {
      throw new Error(`Invalid GUC list value: contains comma or single quote: ${value}`);
    }
  }
}

/** {@link assertSafeGucListValue} + comma-join, as one call. */
export function joinGucList(values: readonly string[]): string {
  assertSafeGucListValue(values);
  return values.join(',');
}

/**
 * Structural view of the IoC container this module bridges to — kept
 * structural (rather than importing the `IoC` class) so wrapped containers
 * work and `drizzle-orm` consumers without `../../ioc` in their object graph
 * pay nothing.
 */
export interface ScopeContainer<TServices> {
  resolve<K extends keyof TServices>(key: K): TServices[K];
  createScope<T2 = object>(): ScopeChild<T2 & TServices>;
}

export interface ScopeChild<TServices> {
  register<K extends keyof TServices>(
    key: K,
    factory: (scope: ScopeChild<TServices>) => TServices[K],
    lifetime?: unknown,
  ): void;
  resolve<K extends keyof TServices>(key: K): TServices[K];
  dispose(opts?: { commit: boolean }): Promise<void>;
}

/**
 * The missing bridge between `../../ioc` and this module: build a factory
 * that creates a child scope whose `db` is a GUC-scoped {@link createScopedDb}
 * proxy — the block every RLS consumer otherwise hand-writes per scope kind
 * (request scope, system scope, grant scope, …).
 *
 * ```ts
 * const createRequestScope = createGucScopeFactory({
 *   container, dbKey: 'db', enabled: config.rls.enabled,
 *   gucs: ({ scopeId }) => ({ 'app.scope_id': scopeId }),
 *   seed: (scope, { actorId }) => scope.register('actorId', () => actorId),
 * });
 * const scope = createRequestScope({ scopeId, actorId });
 * ```
 *
 * When `enabled` is false the `db` override is skipped (the raw db resolves
 * through the parent chain) but `seed` still runs — so consumers can develop
 * against a database without RLS policies using the same wiring.
 */
export function createGucScopeFactory<
  TServices extends Record<TDbKey, RlsDatabase>,
  TArgs,
  TExtra = object,
  TDbKey extends keyof TServices & string = 'db' & keyof TServices & string,
>(opts: {
  container: ScopeContainer<TServices>;
  /** Service key holding the raw Drizzle instance. Default `'db'`. */
  dbKey?: TDbKey;
  /** RLS on/off (e.g. from config). Default `true`. */
  enabled?: boolean;
  /** Session variables for one scope, from the factory's call arguments. */
  gucs: (args: TArgs) => SessionVars;
  /** Extra scoped registrations (ids, tokens, per-scope services). */
  seed?: (scope: ScopeChild<TExtra & TServices>, args: TArgs) => void;
}): (args: TArgs) => ScopeChild<TExtra & TServices> {
  const { container, enabled = true, gucs, seed } = opts;
  const dbKey = (opts.dbKey ?? 'db') as TDbKey;

  return (args: TArgs) => {
    const scope = container.createScope<TExtra>();
    if (enabled) {
      const rawDb = container.resolve(dbKey);
      const scopedDb = createScopedDb(rawDb, gucs(args));
      // A child scope can always register keys typed by its parent's service
      // map — narrow the view to make the override typecheck.
      (scope as ScopeChild<TServices>).register(dbKey, () => scopedDb, ServiceLifetime.Scoped);
    }
    seed?.(scope, args);
    return scope;
  };
}
