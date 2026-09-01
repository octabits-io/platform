/**
 * Unit tests for the events core: codec roundtrips, hub fan-out semantics
 * (scope isolation, audience targeting, fail-closed permissions, error
 * containment), publisher lane routing, and relay watermark behavior —
 * including the bigserial out-of-order-commit case, which is the one that
 * silently loses events if the watermark logic regresses.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  createEventHub,
  createEventPublisher,
  createEventRelay,
  decodeEventNotification,
  isEnvelopePermitted,
  encodeEventPointer,
  encodeInlineEvent,
  type EventEnvelope,
  type EventNotificationListener,
  type EventOutboxStore,
} from './index.ts';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: 'order.created',
    scopeKey: 'scope-a',
    at: '2026-07-29T00:00:00.000Z',
    lane: 'ephemeral',
    data: { orderId: 1 },
    ...overrides,
  };
}

describe('codec', () => {
  it('roundtrips a pointer', () => {
    const decoded = decodeEventNotification(encodeEventPointer('scope-a', 42));
    expect(decoded).toEqual({ kind: 'pointer', scopeKey: 'scope-a', seq: 42 });
  });

  it('roundtrips an inline event', () => {
    const original = envelope();
    const decoded = decodeEventNotification(encodeInlineEvent(original));
    expect(decoded).toEqual({ kind: 'event', envelope: original });
  });

  it('rejects oversized inline events', () => {
    const fat = envelope({ data: { blob: 'x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES) } });
    expect(() => encodeInlineEvent(fat)).toThrow(/notification limit/);
  });

  it('returns null for foreign or malformed payloads', () => {
    expect(decodeEventNotification('not json')).toBeNull();
    expect(decodeEventNotification('{"k":"other"}')).toBeNull();
    expect(decodeEventNotification('{"k":"ptr","s":1,"q":"x"}')).toBeNull();
    expect(decodeEventNotification('{"k":"evt","e":{"id":1}}')).toBeNull();
  });
});

describe('hub', () => {
  it('fans out only within the scope', () => {
    const hub = createEventHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: a });
    hub.subscribe({ scopeKey: 'scope-b', subscriberId: 'u2', onEvent: b });

    const stats = hub.publish(envelope({ scopeKey: 'scope-a' }));
    expect(stats).toEqual({ delivered: 1, filtered: 0 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('applies audience.users targeting', () => {
    const hub = createEventHub();
    const targeted = vi.fn();
    const other = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: targeted });
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u2', onEvent: other });

    hub.publish(envelope({ audience: { users: ['u1'] } }));
    expect(targeted).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('fails closed on permission-carrying events without an authorize predicate', () => {
    const hub = createEventHub();
    const bare = vi.fn();
    const granted = vi.fn();
    const denied = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'bare', onEvent: bare });
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'ok', authorize: () => true, onEvent: granted });
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'no', authorize: () => false, onEvent: denied });

    const stats = hub.publish(envelope({ audience: { permission: { orders: ['read'] } } }));
    expect(bare).not.toHaveBeenCalled();
    expect(granted).toHaveBeenCalledTimes(1);
    expect(denied).not.toHaveBeenCalled();
    expect(stats).toEqual({ delivered: 1, filtered: 2 });
  });

  it('contains a throwing subscriber', () => {
    const hub = createEventHub();
    const healthy = vi.fn();
    hub.subscribe({
      scopeKey: 'scope-a',
      subscriberId: 'boom',
      onEvent: () => {
        throw new Error('boom');
      },
    });
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'ok', onEvent: healthy });

    const stats = hub.publish(envelope());
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(stats.delivered).toBe(1);
  });

  it('tracks counts and active scopes through unsubscribe', () => {
    const hub = createEventHub();
    const un1 = hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: vi.fn() });
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: vi.fn() });
    expect(hub.subscriberCount('scope-a', 'u1')).toBe(2);
    expect(hub.activeScopeKeys()).toEqual(['scope-a']);
    un1();
    expect(hub.subscriberCount('scope-a', 'u1')).toBe(1);
    expect(hub.subscriberCount()).toBe(1);
  });
});

function storeStub(overrides: Partial<EventOutboxStore> = {}): EventOutboxStore {
  return {
    append: vi.fn(async () => ({ seq: 1 })),
    notify: vi.fn(async () => {}),
    readSince: vi.fn(async () => []),
    prune: vi.fn(async () => 0),
    ...overrides,
  };
}

describe('publisher', () => {
  it('routes durable events to append and stamps the returned seq', async () => {
    const store = storeStub({ append: vi.fn(async () => ({ seq: 7 })) });
    const publisher = createEventPublisher({ store });
    const tx = { marker: true };

    const emitted = await publisher.emit(
      { type: 'order.created', scopeKey: 'scope-a', lane: 'durable', data: { orderId: 1 } },
      tx,
    );
    expect(emitted.seq).toBe(7);
    expect(emitted.id).toBeTruthy();
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'order.created' }), tx);
    expect(store.notify).not.toHaveBeenCalled();
  });

  it('routes ephemeral events to notify', async () => {
    const store = storeStub();
    const publisher = createEventPublisher({ store });
    await publisher.emit({ type: 'progress.tick', scopeKey: 'scope-a', lane: 'ephemeral', data: {} });
    expect(store.notify).toHaveBeenCalledTimes(1);
    expect(store.append).not.toHaveBeenCalled();
  });

  it('throws on an invalid envelope (empty type) before touching the store', async () => {
    const store = storeStub();
    const publisher = createEventPublisher({ store });
    await expect(
      publisher.emit({ type: '', scopeKey: 'scope-a', lane: 'durable', data: {} }),
    ).rejects.toThrow();
    expect(store.append).not.toHaveBeenCalled();
  });

  it('propagates store failures (the transaction-rollback contract)', async () => {
    const store = storeStub({
      append: vi.fn(async () => {
        throw new Error('insert failed');
      }),
    });
    const publisher = createEventPublisher({ store });
    await expect(
      publisher.emit({ type: 'order.created', scopeKey: 'scope-a', lane: 'durable', data: {} }),
    ).rejects.toThrow('insert failed');
  });

  it('validates data against the registered payload schema', async () => {
    const store = storeStub({ append: vi.fn(async () => ({ seq: 1 })) });
    const publisher = createEventPublisher<{ 'order.created': { orderId: number } }>({
      store,
      payloadSchemas: { 'order.created': z.object({ orderId: z.number() }) },
    });

    await publisher.emit({
      type: 'order.created',
      scopeKey: 'scope-a',
      lane: 'durable',
      data: { orderId: 1 },
    });
    expect(store.append).toHaveBeenCalledTimes(1);

    await expect(
      publisher.emit({
        type: 'order.created',
        scopeKey: 'scope-a',
        lane: 'durable',
        // Wrong shape on purpose — the runtime schema must catch what a cast slipped past.
        data: { orderId: 'not-a-number' } as unknown as { orderId: number },
      }),
    ).rejects.toThrow();
    expect(store.append).toHaveBeenCalledTimes(1);
  });

  it('treats the schema registry as authoritative: unregistered types throw', async () => {
    const store = storeStub();
    const publisher = createEventPublisher({
      store,
      payloadSchemas: { 'order.created': z.object({ orderId: z.number() }) },
    });
    await expect(
      publisher.emit({ type: 'order.deleted', scopeKey: 'scope-a', lane: 'ephemeral', data: {} }),
    ).rejects.toThrow('No payload schema registered for event type "order.deleted"');
    expect(store.notify).not.toHaveBeenCalled();
  });

  it('validates without stripping — consumer-merged extras on data survive', async () => {
    const store = storeStub();
    const publisher = createEventPublisher({
      store,
      payloadSchemas: { 'order.created': z.object({ orderId: z.number() }) },
    });
    const emitted = await publisher.emit({
      type: 'order.created',
      scopeKey: 'scope-a',
      lane: 'ephemeral',
      data: { orderId: 1, activity: { id: 5 } },
    });
    expect(emitted.data).toEqual({ orderId: 1, activity: { id: 5 } });
    expect(store.notify).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 1, activity: { id: 5 } } }),
      undefined,
    );
  });
});

/** A hand-cranked listener the tests drive directly. */
function manualListener() {
  let handlers: { onNotification: (payload: string) => void; onReconnect?: () => void } | undefined;
  const listener: EventNotificationListener = {
    start: async (h) => {
      handlers = h;
    },
    stop: async () => {},
  };
  return {
    listener,
    notify: (payload: string) => handlers?.onNotification(payload),
    reconnect: () => handlers?.onReconnect?.(),
  };
}

function durableRow(seq: number, scopeKey = 'scope-a'): EventEnvelope {
  return envelope({ id: `evt-${seq}`, seq, scopeKey, lane: 'durable' });
}

async function flush(): Promise<void> {
  // The relay serializes reads on a promise chain; two ticks drain it.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('relay', () => {
  it('publishes inline ephemeral events directly', async () => {
    const hub = createEventHub();
    const seen = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: seen });
    const { listener, notify } = manualListener();
    const relay = createEventRelay({ hub, store: storeStub(), listener });
    await relay.start();

    notify(encodeInlineEvent(envelope({ id: 'inline-1' })));
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ id: 'inline-1' }));
  });

  it('resolves pointers through the outbox and advances the watermark', async () => {
    const hub = createEventHub();
    const seen = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: seen });
    // Rows land as their transactions commit, matching pointer arrival.
    const rows = [durableRow(1)];
    const readSince = vi.fn(async (_scope: string, afterSeq: number) =>
      rows.filter((row) => (row.seq ?? 0) > afterSeq),
    );
    const { listener, notify } = manualListener();
    const relay = createEventRelay({ hub, store: { readSince }, listener });
    await relay.start();

    notify(encodeEventPointer('scope-a', 1));
    await flush();
    rows.push(durableRow(2));
    notify(encodeEventPointer('scope-a', 2));
    await flush();

    expect(seen).toHaveBeenCalledTimes(2);
    // Second pointer read from the watermark (1), not from scratch.
    expect(readSince).toHaveBeenLastCalledWith('scope-a', 1, expect.any(Number));
  });

  it('recovers a late-committing row below the watermark (bigserial gap)', async () => {
    const hub = createEventHub();
    const seen = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: seen });
    // Row 6 committed first; row 5's transaction commits late.
    const rows = [durableRow(6)];
    const readSince = vi.fn(async (_scope: string, afterSeq: number) =>
      rows.filter((row) => (row.seq ?? 0) > afterSeq).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    );
    const { listener, notify } = manualListener();
    const relay = createEventRelay({ hub, store: { readSince }, listener });
    await relay.start();

    notify(encodeEventPointer('scope-a', 6));
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);

    rows.push(durableRow(5));
    notify(encodeEventPointer('scope-a', 5));
    await flush();

    // Read restarted below the late row: both 5 and 6 delivered (6 is a
    // duplicate — client dedupe absorbs it), nothing lost.
    expect(readSince).toHaveBeenLastCalledWith('scope-a', 4, expect.any(Number));
    const deliveredSeqs = seen.mock.calls.map(([env]) => (env as EventEnvelope).seq);
    expect(deliveredSeqs).toContain(5);
  });

  it('skips outbox reads for scopes with no subscribers', async () => {
    const hub = createEventHub();
    const readSince = vi.fn(async () => []);
    const { listener, notify } = manualListener();
    const relay = createEventRelay({ hub, store: { readSince }, listener });
    await relay.start();

    notify(encodeEventPointer('scope-empty', 3));
    await flush();
    expect(readSince).not.toHaveBeenCalled();
  });

  it('catches up watermarked scopes on reconnect', async () => {
    const hub = createEventHub();
    const seen = vi.fn();
    hub.subscribe({ scopeKey: 'scope-a', subscriberId: 'u1', onEvent: seen });
    const rows = [durableRow(1)];
    const readSince = vi.fn(async (_scope: string, afterSeq: number) =>
      rows.filter((row) => (row.seq ?? 0) > afterSeq),
    );
    const { listener, notify, reconnect } = manualListener();
    const relay = createEventRelay({ hub, store: { readSince }, listener });
    await relay.start();

    notify(encodeEventPointer('scope-a', 1));
    await flush();
    rows.push(durableRow(2)); // arrived while the listener was down
    reconnect();
    await flush();

    const deliveredSeqs = seen.mock.calls.map(([env]) => (env as EventEnvelope).seq);
    expect(deliveredSeqs).toContain(2);
  });
});

// ===========================================================================
// isEnvelopePermitted — the fail-closed filter, on its own
// ===========================================================================

/**
 * The hub tests above prove fan-out honours this; these pin the predicate
 * itself, because it is exported for consumers that filter outside a hub
 * (a replay pass, a second transport) and because every one of its branches
 * is a way to deliver an event to someone who should not see it.
 */
describe('isEnvelopePermitted', () => {
  const subscriber = (over: Partial<Parameters<typeof isEnvelopePermitted>[1]> = {}) => ({
    subscriberId: 'u1',
    ...over,
  });

  it('permits an envelope with no audience', () => {
    expect(isEnvelopePermitted(envelope(), subscriber())).toBe(true);
  });

  it('filters by the audience user list', () => {
    const targeted = envelope({ audience: { users: ['u2'] } });
    expect(isEnvelopePermitted(targeted, subscriber({ subscriberId: 'u1' }))).toBe(false);
    expect(isEnvelopePermitted(targeted, subscriber({ subscriberId: 'u2' }))).toBe(true);
  });

  it('fails CLOSED on a permission demand when the subscriber brought no authorize predicate', () => {
    // The load-bearing branch: a subscriber that cannot answer "may I see
    // this?" must not be treated as allowed.
    const guarded = envelope({ audience: { permission: { orders: ['read'] } } });
    expect(isEnvelopePermitted(guarded, subscriber())).toBe(false);
  });

  it('defers to authorize whenever one is present — including for an unguarded envelope', () => {
    const authorize = vi.fn().mockReturnValue(false);
    // No permission demand, but the predicate still decides: a subscriber may
    // narrow its own feed beyond what the envelope asks for.
    expect(isEnvelopePermitted(envelope(), subscriber({ authorize }))).toBe(false);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it('checks the user list BEFORE authorize, so a targeted envelope cannot be authorized around', () => {
    const authorize = vi.fn().mockReturnValue(true);
    const targeted = envelope({ audience: { users: ['u2'] } });

    expect(isEnvelopePermitted(targeted, subscriber({ subscriberId: 'u1', authorize }))).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
  });
});
