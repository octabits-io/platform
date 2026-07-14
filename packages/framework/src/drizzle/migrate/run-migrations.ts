import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

/**
 * Structural logger seam for migration progress (matches the shape of
 * `@octabits-io/framework/logger`'s `Logger` for the two methods used).
 */
export interface MigrationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error): void;
}

/** Console-backed fallback used when `logger: true` is passed. */
const consoleMigrationLogger: MigrationLogger = {
  info: (message, meta) => {
    if (meta) console.log(message, meta);
    else console.log(message);
  },
  error: (message, error) => {
    if (error) console.error(message, error);
    else console.error(message);
  },
};

export interface RunMigrationsOptions {
  connectionString: string;
  /** Absolute path to the folder containing the generated migration files. */
  migrationsFolder: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  /**
   * Structured logger for migration progress. Pass a {@link MigrationLogger}
   * to integrate with your logging stack, `true` for a plain console fallback,
   * or omit/`false` for complete silence (nothing is printed, including on
   * failure — the error is still thrown).
   */
  logger?: boolean | MigrationLogger;
  /**
   * Session GUC variables applied (via `set_config(name, value, false)`) on the
   * migration connection before `migrate()` runs. Use this to bypass RLS for
   * data migrations, e.g. `{ 'app.system_mode': 'true' }`.
   */
  sessionVars?: Record<string, string>;
}

/**
 * Run pending database migrations.
 * This is idempotent — already applied migrations will be skipped.
 *
 * @param options - Connection + migration options
 * @returns Promise that resolves when migrations are complete
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const logger: MigrationLogger | undefined =
    options.logger === true
      ? consoleMigrationLogger
      : typeof options.logger === 'object'
        ? options.logger
        : undefined;

  const client = new Client({
    connectionString: options.connectionString,
    ssl: options.ssl,
  });

  try {
    await client.connect();

    // Apply session variables (e.g. RLS bypass) before migrating so data
    // migrations (UPDATE/DELETE) on protected tables work.
    for (const [name, value] of Object.entries(options.sessionVars ?? {})) {
      await client.query('SELECT set_config($1, $2, false)', [name, value]);
    }

    const db = drizzle({ client });

    logger?.info('Running database migrations', {
      migrationsFolder: options.migrationsFolder,
    });

    await migrate(db, { migrationsFolder: options.migrationsFolder });

    logger?.info('Database migrations completed successfully');
  } catch (error) {
    logger?.error(
      'Migration failed',
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  } finally {
    await client.end();
  }
}
