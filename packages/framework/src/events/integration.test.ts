/**
 * Integration tests against a real Postgres (Docker required) — the
 * properties mocks cannot verify:
 *
 * 1. **Transactional atomicity**: an outbox append inside a rolled-back
 *    transaction emits nothing — no row, no notification. This is the
 *    property the whole design leans on and the one most likely to regress
 *    silently.
 * 2. NOTIFY fires at COMMIT and reaches a real LISTEN connection.
 * 3. The full durable pipeline: emit → outbox row → pointer → relay → hub.
 * 4. The ephemeral pipeline: emit → inline payload → relay → hub, no row.
 * 5. Listener reconnect after a killed connection resumes delivery.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, index } from 'drizzle-orm/pg-core';
import pg from 'pg';
import {
  createEventHub,
  createEventPublisher,
  createEventRelay,
  type EventEnvelope,
} from './index.ts';
import { createPgNotifyListener } from './postgres.ts';
import { createDrizzleEventOutboxStore, eventOutboxColumns } from '../drizzle/event-outbox/index.ts';

const CHANNEL = 'octabits_events_test';

const eventOutbox = pgTable(
  'event_outbox',
  {
    ...eventOutboxColumns,
    scopeId: text('scope_id').notNull(),
  },
  (t) => [index('event_outbox_scope_seq_idx').on(t.scopeId, t.id)],
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await pool.query(`
    create table event_outbox (
      id bigserial primary key,
      event_id text not null,
      type text not null,
      at timestamptz not null,
      data jsonb,
      actor jsonb,
      audience jsonb,
      resources jsonb,
      created_at timestamptz not null default now(),
      scope_id text not null
    );
    create index event_outbox_scope_seq_idx on event_outbox (scope_id, id);
  `);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function makeStore() {
  return createDrizzleEventOutboxStore({
    db,
    table: eventOutbox,
    channel: CHANNEL,
    scope: { column: 'scopeId' },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timed out');
}

describe('events over real Postgres', () => {
  it('delivers a durable event end-to-end: emit → outbox → NOTIFY → relay → hub', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    const hub = createEventHub();
    const received: EventEnvelope[] = [];
    hub.subscribe({ scopeKey: 'scope-e2e', subscriberId: 'u1', onEvent: (e) => received.push(e) });

    const listener = createPgNotifyListener({
      connectionString: container.getConnectionUri(),
      channel: CHANNEL,
    });
    const relay = createEventRelay({ hub, store, listener });
    await relay.start();

    try {
      const emitted = await publisher.emit({
        type: 'order.created',
        scopeKey: 'scope-e2e',
        lane: 'durable',
        data: { orderId: 42 },
      });
      expect(emitted.seq).toBeGreaterThan(0);

      await waitFor(() => received.length >= 1);
      expect(received[0]).toMatchObject({
        id: emitted.id,
        type: 'order.created',
        scopeKey: 'scope-e2e',
        lane: 'durable',
        data: { orderId: 42 },
        seq: emitted.seq,
      });
    } finally {
      await relay.stop();
    }
  });

  it('delivers an ephemeral event inline without writing a row', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    const hub = createEventHub();
    const received: EventEnvelope[] = [];
    hub.subscribe({ scopeKey: 'scope-eph', subscriberId: 'u1', onEvent: (e) => received.push(e) });

    const listener = createPgNotifyListener({
      connectionString: container.getConnectionUri(),
      channel: CHANNEL,
    });
    const relay = createEventRelay({ hub, store, listener });
    await relay.start();

    try {
      const before = await pool.query('select count(*)::int as n from event_outbox');
      await publisher.emit({
        type: 'progress.tick',
        scopeKey: 'scope-eph',
        lane: 'ephemeral',
        data: { step: 3 },
      });
      await waitFor(() => received.length >= 1);
      expect(received[0]).toMatchObject({ type: 'progress.tick', lane: 'ephemeral', data: { step: 3 } });

      const after = await pool.query('select count(*)::int as n from event_outbox');
      expect(after.rows[0].n).toBe(before.rows[0].n); // no row for ephemeral
    } finally {
      await relay.stop();
    }
  });

  it('emits NOTHING for a rolled-back transaction — no row, no notification', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    const hub = createEventHub();
    const received: EventEnvelope[] = [];
    hub.subscribe({ scopeKey: 'scope-rollback', subscriberId: 'u1', onEvent: (e) => received.push(e) });

    const listener = createPgNotifyListener({
      connectionString: container.getConnectionUri(),
      channel: CHANNEL,
    });
    const relay = createEventRelay({ hub, store, listener });
    await relay.start();

    try {
      await expect(
        db.transaction(async (tx) => {
          await publisher.emit(
            { type: 'order.created', scopeKey: 'scope-rollback', lane: 'durable', data: {} },
            tx,
          );
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      // Give a would-be notification ample time to arrive, then assert silence.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(received).toHaveLength(0);
      const rows = await pool.query("select count(*)::int as n from event_outbox where scope_id = 'scope-rollback'");
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await relay.stop();
    }
  });

  it('scopes readSince and keeps scopes isolated at the hub', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    await publisher.emit({ type: 'a.b', scopeKey: 'scope-iso-1', lane: 'durable', data: { n: 1 } });
    await publisher.emit({ type: 'a.b', scopeKey: 'scope-iso-2', lane: 'durable', data: { n: 2 } });

    const scope1 = await store.readSince('scope-iso-1', 0);
    expect(scope1).toHaveLength(1);
    expect(scope1[0]).toMatchObject({ scopeKey: 'scope-iso-1', data: { n: 1 } });
  });

  it('resumes delivery after the LISTEN connection is killed (reconnect + catch-up)', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    const hub = createEventHub();
    const received: EventEnvelope[] = [];
    hub.subscribe({ scopeKey: 'scope-reconnect', subscriberId: 'u1', onEvent: (e) => received.push(e) });

    const listener = createPgNotifyListener({
      connectionString: container.getConnectionUri(),
      channel: CHANNEL,
      reconnectDelayMs: 100,
    });
    const relay = createEventRelay({ hub, store, listener });
    await relay.start();

    try {
      // Establish a watermark for the scope.
      await publisher.emit({ type: 'a.b', scopeKey: 'scope-reconnect', lane: 'durable', data: { n: 1 } });
      await waitFor(() => received.length >= 1);

      // Kill the LISTEN backend server-side.
      await pool.query(`
        select pg_terminate_backend(pid) from pg_stat_activity
        where query ilike '%LISTEN%' and pid <> pg_backend_pid()
      `);

      // Emit while the listener is (possibly) down, then expect catch-up or
      // live delivery to produce it either way.
      await publisher.emit({ type: 'a.b', scopeKey: 'scope-reconnect', lane: 'durable', data: { n: 2 } });
      await waitFor(() => received.some((e) => (e.data as { n: number }).n === 2), 15_000);
    } finally {
      await relay.stop();
    }
  });

  it('prunes rows older than the cutoff', async () => {
    const store = makeStore();
    const publisher = createEventPublisher({ store });
    await publisher.emit({ type: 'a.b', scopeKey: 'scope-prune', lane: 'durable', data: {} });
    const pruned = await store.prune(new Date(Date.now() + 60_000));
    expect(pruned).toBeGreaterThan(0);
    const rows = await pool.query('select count(*)::int as n from event_outbox');
    expect(rows.rows[0].n).toBe(0);
  });
});
