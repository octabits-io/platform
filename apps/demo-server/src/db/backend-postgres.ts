/**
 * `DatabaseBackend` over a real Postgres server via `pg`. What the demo ran on
 * exclusively before PGlite; kept because the framework's own claim — "each
 * module against a real Postgres" — is only honest while this path stays
 * exercised (`DATABASE_URL` + the compose file).
 *
 * Four independent connection owners share one URL here, and that is by
 * design: the app pool, pg-boss's own pool, and one dedicated connection each
 * for the event listener and the broadcast listener (LISTEN must never run on
 * a pooled checkout — see `…/events/postgres`).
 */
import { Pool, type PoolClient } from 'pg';
import { createDrizzle } from '@octabits-io/framework/drizzle/factory';
import { createPgNotifyListener } from '@octabits-io/framework/events/postgres';
import type { Logger } from '@octabits-io/framework/logger';
import { schema } from './schema.ts';
import type { DatabaseBackend, DemoSql } from './backend.ts';

/** `DemoSql` over one `pg` query surface (a pool, or a checked-out client inside a transaction). */
function sqlOver(run: Pick<Pool | PoolClient, 'query'>, transaction: DemoSql['transaction']): DemoSql {
  return {
    async query<R>(text: string, params?: unknown[]) {
      const res = await run.query(text, params);
      return { rows: res.rows as R[], rowCount: res.rowCount };
    },
    async exec(script) {
      await run.query(script);
    },
    transaction,
  };
}

export async function createPostgresBackend(deps: { url: string; logger: Logger }): Promise<DatabaseBackend> {
  const { url } = deps;
  const pool = new Pool({ connectionString: url });

  const sql: DemoSql = sqlOver(pool, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Nested `transaction` on the tx object runs on the same client — no
      // savepoints; the demo never nests, and flow's store does not either.
      const tx: DemoSql = sqlOver(client, (inner) => inner(tx));
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  return {
    kind: 'postgres',
    db: createDrizzle(schema, { pool }),
    sql,
    boss: { connectionString: url },
    createNotifyListener: (channel, logger) => createPgNotifyListener({ connectionString: url, channel, logger }),
    checkReady: async () => {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
