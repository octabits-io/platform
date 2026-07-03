import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

export interface RunMigrationsOptions {
  connectionString: string;
  /** Absolute path to the folder containing the generated migration files. */
  migrationsFolder: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  logger?: boolean;
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

    if (options.logger) {
      console.log('🔄 Running database migrations...');
      console.log(`   Migrations folder: ${options.migrationsFolder}`);
    }

    await migrate(db, { migrationsFolder: options.migrationsFolder });

    if (options.logger) {
      console.log('✅ Database migrations completed successfully');
    }
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await client.end();
  }
}
