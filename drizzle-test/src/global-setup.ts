import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

declare module 'vitest' {
  export interface ProvidedContext {
    testDbConnectionString: string;
  }
}

export interface GlobalSetupConfig {
  /** PostgreSQL Docker image (default: 'postgres:17-alpine') */
  image?: string;
  /** Path to Drizzle migrations directory */
  migrationsFolder: string;
}

export function createGlobalSetup(options: GlobalSetupConfig) {
  let container: StartedPostgreSqlContainer | null = null;

  async function setup({ provide }: { provide: (key: string, value: string) => void }) {
    const image = options.image ?? 'postgres:17-alpine';

    container = await new PostgreSqlContainer(image)
      .withExposedPorts(5432)
      .start();

    const connectionString = container.getConnectionUri();

    // Run migrations
    const client = new Client({ connectionString });
    try {
      await client.connect();
      const db = drizzle({ client });
      await migrate(db, { migrationsFolder: options.migrationsFolder });
    } finally {
      await client.end();
    }

    provide('testDbConnectionString', connectionString);
  }

  async function teardown() {
    if (container) {
      await container.stop();
      container = null;
    }
  }

  return { setup, teardown };
}
