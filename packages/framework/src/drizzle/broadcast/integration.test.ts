/**
 * Integration tests against a real Postgres (Docker required) — the
 * properties mocks cannot verify:
 *
 * 1. A published message reaches a real LISTEN connection.
 * 2. Publishing inside a transaction delivers at COMMIT — and a rolled-back
 *    transaction delivers nothing (the invalidate-after-write guarantee).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import { createBroadcastChannel } from './index.ts';

const CHANNEL = 'octabits_broadcast_test';

const PAYLOAD_SCHEMA = z.object({
  namespace: z.string(),
  tenantId: z.string(),
});

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

describe('broadcast channel over real Postgres', () => {
  it('delivers a published message to a live subscriber', async () => {
    const channel = createBroadcastChannel({ channel: CHANNEL, schema: PAYLOAD_SCHEMA });
    const received: Array<z.infer<typeof PAYLOAD_SCHEMA>> = [];
    const sub = await channel.subscribe({
      connectionString: container.getConnectionUri(),
      onMessage: (m) => received.push(m),
    });

    try {
      await channel.publish(db, { namespace: 'tenant-config', tenantId: 't1' });
      await waitFor(() => received.length >= 1);
      expect(received[0]).toEqual({ namespace: 'tenant-config', tenantId: 't1' });
    } finally {
      await sub.stop();
    }
  });

  it('delivers at COMMIT and drops on ROLLBACK', async () => {
    const channel = createBroadcastChannel({ channel: CHANNEL, schema: PAYLOAD_SCHEMA });
    const received: Array<z.infer<typeof PAYLOAD_SCHEMA>> = [];
    const sub = await channel.subscribe({
      connectionString: container.getConnectionUri(),
      onMessage: (m) => received.push(m),
    });

    try {
      // Rolled-back tx: the NOTIFY must never surface.
      await db
        .transaction(async (tx) => {
          await channel.publishInTx(tx, { namespace: 'tenant-guard', tenantId: 'rolled-back' });
          throw new Error('force rollback');
        })
        .catch(() => {});

      // Committed tx: delivered exactly once, at commit.
      await db.transaction(async (tx) => {
        await channel.publishInTx(tx, { namespace: 'tenant-guard', tenantId: 'committed' });
      });

      await waitFor(() => received.length >= 1);
      // Give a stray rolled-back delivery a moment to (not) arrive.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(received).toEqual([{ namespace: 'tenant-guard', tenantId: 'committed' }]);
    } finally {
      await sub.stop();
    }
  });
});
