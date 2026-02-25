import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { WORKFLOW_MIGRATION_SQL } from '../src/workflow/tables.ts';

let container: StartedPostgreSqlContainer | null = null;

export async function setup({ provide }: { provide: (key: string, value: string) => void }) {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withExposedPorts(5432)
    .start();

  const connectionString = container.getConnectionUri();

  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(WORKFLOW_MIGRATION_SQL);
  } finally {
    await client.end();
  }

  provide('testDbConnectionString', connectionString);
}

export async function teardown() {
  if (container) {
    await container.stop();
    container = null;
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDbConnectionString: string;
  }
}
