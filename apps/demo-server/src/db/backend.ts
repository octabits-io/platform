/**
 * The database backend seam: everything in this app that needs "the
 * database" — Drizzle, raw SQL, pg-boss, the LISTEN side of events and
 * broadcasts, the readiness probe — gets it from one `DatabaseBackend`, built
 * once at boot from config. Two implementations:
 *
 *   - `backend-postgres.ts` — a real server over `pg` (`DATABASE_URL` set).
 *   - `backend-pglite.ts`   — PGlite, WASM Postgres embedded in this process
 *                              (the zero-config default: no Docker).
 *
 * The rest of the app never learns which one it got. That is only possible
 * because every framework and flow module involved takes a *structural* seam
 * rather than a `pg` type: `createWorkflowStore({ exec })` and
 * `createPostgresObjectStorageService({ db })` share the `SqlExecutor` shape
 * `DemoSql` extends, `createBossManager` takes either a connection string or a
 * pg-boss `Db` adapter, and the relay/broadcast take any
 * `EventNotificationListener`.
 */
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { BossManagerConfig } from '@octabits-io/framework/queue';
import type { EventNotificationListener } from '@octabits-io/framework/events';
import type { Logger } from '@octabits-io/framework/logger';
import type { Schema } from './schema.ts';
import type { AppConfig } from '../config.ts';
import { createPostgresBackend } from './backend-postgres.ts';
import { createPgliteBackend } from './backend-pglite.ts';

/**
 * Raw parameterized SQL — the one shape both `octaflow/store-pg`'s
 * `SqlExecutor` and `…/storage/postgres`'s `SqlExecutor` accept, plus `exec`
 * for the multi-statement DDL scripts (`db/ddl.ts`) that the extended query
 * protocol refuses (one statement per `query`).
 */
export interface DemoSql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  /** Run `fn` in one transaction: commit on return, roll back on throw. */
  transaction<T>(fn: (tx: DemoSql) => Promise<T>): Promise<T>;
  /** Run a multi-statement script (simple query protocol). */
  exec(script: string): Promise<void>;
}

export interface DatabaseBackend {
  readonly kind: AppConfig['database']['kind'];
  /** The app's Drizzle instance over the same database. */
  readonly db: AppDatabase<Schema>;
  /** Raw SQL over the same database (flow store, AI usage tables, DDL, storage). */
  readonly sql: DemoSql;
  /** How `createBossManager` reaches the same database. */
  readonly boss: Pick<BossManagerConfig, 'connectionString' | 'db' | 'backend'>;
  /** The LISTEN side for one notification channel (event relay, broadcast). */
  createNotifyListener(channel: string, logger: Logger): EventNotificationListener;
  /** Readiness probe (`/health/ready`). Throws when the database is unreachable. */
  checkReady(): Promise<void>;
  /** Release the connection(s). Called last in shutdown, after every consumer stopped. */
  close(): Promise<void>;
}

export async function createDatabaseBackend(
  config: AppConfig['database'],
  logger: Logger,
): Promise<DatabaseBackend> {
  return config.kind === 'postgres'
    ? createPostgresBackend({ url: config.url, logger })
    : createPgliteBackend({ dataDir: config.dataDir, logger });
}
