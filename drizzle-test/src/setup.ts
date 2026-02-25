import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

let testPool: Pool | null = null;

export interface SetupTestDatabaseOptions<TSchema extends Record<string, unknown>> {
  /** Drizzle schema object — passed to drizzle() constructor */
  schema: TSchema;
  /** Enable Drizzle query logging (default: false) */
  logger?: boolean;
}

/**
 * Sets up a test database connection using the shared container.
 *
 * Gets the connection string from globalSetup via Vitest's inject() API,
 * creates a connection pool, and returns a typed Drizzle instance.
 *
 * Call in beforeAll().
 */
export async function setupTestDatabase<TSchema extends Record<string, unknown>>(
  options: SetupTestDatabaseOptions<TSchema>,
): Promise<NodePgDatabase<TSchema>> {
  const { inject } = await import('vitest');
  const connectionString = inject('testDbConnectionString');

  if (!connectionString) {
    throw new Error(
      'Test database not initialized. Make sure vitest.config.ts has globalSetup configured.',
    );
  }

  testPool = new Pool({ connectionString });

  return drizzle({
    client: testPool,
    schema: options.schema,
    logger: options.logger ?? false,
  });
}

/**
 * Closes the connection pool. Call in afterAll().
 */
export async function cleanupTestDatabase(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = null;
  }
}

/**
 * Truncates the given tables for test isolation.
 * Call in beforeEach() or afterEach().
 *
 * Tables must be listed in dependency order (children before parents)
 * to avoid foreign key constraint violations, or rely on CASCADE.
 */
export async function resetDatabase(
  db: NodePgDatabase<any>,
  tables: PgTable[],
): Promise<void> {
  if (tables.length === 0) return;

  const tableNames = tables
    .map((t) => {
      const { name, schema } = getTableConfig(t);
      return `"${schema ?? 'public'}"."${name}"`;
    })
    .join(', ');

  await db.execute(sql.raw(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`));
}
