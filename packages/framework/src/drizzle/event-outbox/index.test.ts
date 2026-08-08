/**
 * Unit tests for the outbox store's single-scope guard. The store's SQL paths
 * are covered end-to-end against real Postgres in `events/integration.test.ts`;
 * what is asserted here is pure decision logic that runs BEFORE any query, so
 * it needs no database.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDrizzleEventOutboxStore } from './index.ts';
import type { EventEnvelope } from '../../events/types.ts';

/**
 * `notify()` touches exactly one db method (`execute`), and the guard runs
 * before it — enough surface to prove both the allow and the refuse paths.
 */
function makeStore(scope?: { column: string; value?: string }) {
  const execute = vi.fn(async () => undefined);
  const db = { execute } as never;
  const table = { id: 'id', scopeId: 'scope_id' } as never;
  return {
    execute,
    store: createDrizzleEventOutboxStore({ db, table, channel: 'events_test', scope }),
  };
}

function ephemeral(scopeKey: string): EventEnvelope {
  return {
    id: `evt-${scopeKey}`,
    type: 'progress.tick',
    scopeKey,
    at: '2026-08-08T00:00:00.000Z',
    lane: 'ephemeral',
    data: {},
  };
}

describe('createDrizzleEventOutboxStore — single-scope guard', () => {
  it('allows a single scope key to repeat when no scope column is configured', async () => {
    const { store, execute } = makeStore();

    await store.notify(ephemeral('only-scope'));
    await store.notify(ephemeral('only-scope'));

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refuses a second distinct scope key instead of silently mixing scopes', async () => {
    // Without a scope column there is nothing to filter on, so readSince()
    // would return every scope's rows and label them with whoever asked. Fail
    // at the write that proves the deployment is multi-scope, not at the read
    // that leaks.
    const { store, execute } = makeStore();

    await store.notify(ephemeral('scope-a'));
    await expect(store.notify(ephemeral('scope-b'))).rejects.toThrow(/without a 'scope'/);

    expect(execute).toHaveBeenCalledTimes(1); // the second never reached the db
  });

  it('refuses a readSince for a different scope than the one in play', async () => {
    // The guard has to bite on read too: a replica that only serves SSE never
    // appends, so a write-side check alone would never fire there.
    const { store, execute } = makeStore();

    await store.notify(ephemeral('scope-a'));
    await expect(store.readSince('scope-b', 0)).rejects.toThrow(/readSince\(\)/);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('names both scope keys and the fix in the error', async () => {
    const { store } = makeStore();
    await store.notify(ephemeral('scope-a'));

    await expect(store.notify(ephemeral('scope-b'))).rejects.toThrow(
      /'scope-a' then 'scope-b'[\s\S]*createDrizzleEventOutboxStore/,
    );
  });

  it('does not constrain scope keys once a scope column IS configured', async () => {
    // The normal multi-scope setup: the column exists, so every read filters.
    const { store, execute } = makeStore({ column: 'scopeId' });

    await store.notify(ephemeral('scope-a'));
    await store.notify(ephemeral('scope-b'));

    expect(execute).toHaveBeenCalledTimes(2);
  });
});
