/**
 * `DatabaseBackend` over PGlite — Postgres compiled to WASM and running inside
 * this Bun process. No server, no Docker, no connection string: the default
 * when `DATABASE_URL` is unset.
 *
 * What changes versus a server, and what the seams absorb:
 *
 *   - **One connection.** Every consumer (Drizzle, the flow store, pg-boss, the
 *     blob store) shares it, and PGlite serializes their queries. A pg-boss
 *     fetch transaction briefly blocks app queries — fine for a demo, and the
 *     reason `backend: 'pglite'` exists: it turns off the multi-connection
 *     machinery pg-boss would otherwise assume.
 *   - **LISTEN/NOTIFY is in-process.** The instance that NOTIFYs is the one
 *     that listens, so `…/events/pglite` replaces the dedicated-connection
 *     listener; `pg_notify` inside a transaction is still delivered at COMMIT.
 *   - **Driver types differ.** `int8` is parsed to `number` here explicitly
 *     (the framework's Drizzle factory does the same on `pg`'s global parser
 *     registry, which PGlite does not read) and `bytea` arrives as a plain
 *     `Uint8Array` — the framework's `bytea` column type and the blob provider
 *     both normalize it to `Buffer`, so application code sees one type.
 *   - **Durability.** PGlite runs with fsync off. Treat the data dir as
 *     disposable; `memory://` skips the disk entirely.
 *   - **One process per data dir.** A second server on the same directory will
 *     not get a second connection — it gets a lock error.
 */
import { PGlite, types } from '@electric-sql/pglite';
import type { Transaction as PgliteTransaction } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { fromPglite } from 'pg-boss';
import { augmentDrizzle } from '@octabits-io/framework/drizzle/factory';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import { createPgliteNotifyListener } from '@octabits-io/framework/events/pglite';
import type { Logger } from '@octabits-io/framework/logger';
import { schema, type Schema } from './schema.ts';
import type { DatabaseBackend, DemoSql } from './backend.ts';

/** The query surface a PGlite instance and one of its transactions share. */
type PgliteQueries = Pick<PgliteTransaction, 'query' | 'exec'>;

/** `DemoSql` over a PGlite query surface. */
function sqlOver(run: PgliteQueries, transaction: DemoSql['transaction']): DemoSql {
  return {
    async query<R>(text: string, params?: unknown[]) {
      const res = await run.query<R>(text, params);
      // PGlite reports `affectedRows` for DML; `pg` reports `rowCount`.
      return { rows: res.rows, rowCount: res.affectedRows ?? null };
    },
    async exec(script) {
      await run.exec(script);
    },
    transaction,
  };
}

export async function createPgliteBackend(deps: { dataDir: string; logger: Logger }): Promise<DatabaseBackend> {
  const { dataDir, logger } = deps;
  const pglite = await PGlite.create(dataDir, {
    parsers: { [types.INT8]: Number },
  });
  logger.info('PGlite ready', { dataDir });

  const sql: DemoSql = sqlOver(pglite, (fn) =>
    pglite.transaction((pgliteTx) => {
      // Nested `transaction` on the tx object runs inside the same transaction —
      // no savepoints; the demo never nests, and flow's store does not either.
      const tx: DemoSql = sqlOver(pgliteTx, (inner) => inner(tx));
      return fn(tx);
    }),
  );

  // Same augmentation the framework's `createDrizzle` applies over `pg`
  // (`.tables`, transaction-aware `.transaction()`), over the PGlite driver.
  // The cast is the one `createDrizzleFromClient` makes too: `$client` differs,
  // the query surface the app uses does not.
  const db = augmentDrizzle(drizzle({ client: pglite, schema }), schema) as unknown as AppDatabase<Schema>;

  return {
    kind: 'pglite',
    db,
    sql,
    // pg-boss ships the adapter; `backend: 'pglite'` selects its embedded profile.
    boss: { db: fromPglite(pglite), backend: 'pglite' },
    createNotifyListener: (channel, listenerLogger) =>
      createPgliteNotifyListener({ pglite, channel, logger: listenerLogger }),
    checkReady: async () => {
      await pglite.query('SELECT 1');
    },
    close: () => pglite.close(),
  };
}
