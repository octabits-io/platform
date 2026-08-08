/**
 * Unit tests for the SSE stream handler: response headers (the
 * `x-accel-buffering: no` assertion is the single most important line in this
 * file — see the module doc), auth/limit responses, the durable-only `id:`
 * watermark rule, replay, and connection accounting.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEventHub } from './hub.ts';
import { createEventStreamHandler, type ResolvedEventSubscriber } from './sse.ts';
import type { EventEnvelope } from './types.ts';

const subscriber: ResolvedEventSubscriber = { scopeKey: 'scope-a', subscriberId: 'u1' };

function durable(seq: number): EventEnvelope {
  return {
    id: `evt-${seq}`,
    seq,
    type: 'order.created',
    scopeKey: 'scope-a',
    at: '2026-07-29T00:00:00.000Z',
    lane: 'durable',
    data: {},
  };
}

function ephemeral(id: string): EventEnvelope {
  return {
    id,
    type: 'progress.tick',
    scopeKey: 'scope-a',
    at: '2026-07-29T00:00:00.000Z',
    lane: 'ephemeral',
    data: {},
  };
}

function request(headers: Record<string, string> = {}): { req: Request; abort: () => void } {
  const controller = new AbortController();
  return {
    req: new Request('http://localhost/events', { headers, signal: controller.signal }),
    abort: () => controller.abort(),
  };
}

async function readUntil(response: Response, predicate: (buffer: string) => boolean, timeoutMs = 2_000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(buffer)) {
      if (Date.now() > deadline) throw new Error(`timeout; buffer so far:\n${buffer}`);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  } finally {
    reader.releaseLock();
  }
}

describe('createEventStreamHandler', () => {
  it('sets the SSE headers, including the load-bearing x-accel-buffering: no', async () => {
    const hub = createEventHub();
    const { handler } = createEventStreamHandler({ hub, resolveSubscriber: () => subscriber });
    const { req, abort } = request();
    const response = await handler(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    abort();
  });

  it('rejects unresolved subscribers with 401', async () => {
    const hub = createEventHub();
    const { handler } = createEventStreamHandler({ hub, resolveSubscriber: () => null });
    const response = await handler(request().req);
    expect(response.status).toBe(401);
  });

  it('enforces the per-subscriber connection cap with 429', async () => {
    const hub = createEventHub();
    const { handler, metrics } = createEventStreamHandler({
      hub,
      resolveSubscriber: () => subscriber,
      maxConnectionsPerSubscriber: 1,
    });
    const first = request();
    const ok = await handler(first.req);
    expect(ok.status).toBe(200);
    expect(metrics.connections()).toBe(1);

    const limited = await handler(request().req);
    expect(limited.status).toBe(429);

    first.abort();
    // Abort listeners run synchronously on signal dispatch.
    expect(metrics.connections()).toBe(0);
    const afterClose = await handler(request().req);
    expect(afterClose.status).toBe(200);
  });

  it('frames durable events with id: and ephemeral events without (watermark rule)', async () => {
    const hub = createEventHub();
    const { handler } = createEventStreamHandler({ hub, resolveSubscriber: () => subscriber });
    const { req, abort } = request();
    const response = await handler(req);

    hub.publish(durable(41));
    hub.publish(ephemeral('inline-1'));
    const buffer = await readUntil(response, (b) => b.includes('inline-1'));

    expect(buffer).toMatch(/^retry: 3000\n\n/);
    expect(buffer).toContain('id: 41\nevent: order.created\n');
    // The ephemeral frame must NOT carry an id: line.
    const ephemeralFrame = buffer.slice(buffer.indexOf('event: progress.tick') - 30);
    expect(ephemeralFrame).not.toContain('id:');
    abort();
  });

  it('replays from the lookback window on Last-Event-ID and stays live', async () => {
    const hub = createEventHub();
    const readSince = vi.fn(async (_scope: string, afterSeq: number) =>
      [durable(41), durable(42)].filter((row) => (row.seq ?? 0) > afterSeq),
    );
    const { handler } = createEventStreamHandler({
      hub,
      resolveSubscriber: () => subscriber,
      store: { readSince },
      replayLookback: 2,
    });
    const { req, abort } = request({ 'last-event-id': '42' });
    const response = await handler(req);

    const buffer = await readUntil(response, (b) => b.includes('id: 42'));
    expect(readSince).toHaveBeenCalledWith('scope-a', 40, expect.any(Number));
    expect(buffer).toContain('id: 41');
    expect(buffer).toContain('id: 42');

    hub.publish(durable(43));
    const live = await readUntil(response, (b) => b.includes('id: 43'));
    expect(live).toContain('id: 43');
    abort();
  });

  it('withholds permission-carrying events when the subscriber cannot evaluate them', async () => {
    const hub = createEventHub();
    const canRead = vi.fn((permission: unknown) => permission === 'granted');
    const { handler } = createEventStreamHandler({
      hub,
      resolveSubscriber: () => ({ ...subscriber, can: canRead }),
    });
    const { req, abort } = request();
    const response = await handler(req);

    hub.publish({ ...durable(1), audience: { permission: 'denied' } });
    hub.publish({ ...durable(2), id: 'allowed', audience: { permission: 'granted' } });
    const buffer = await readUntil(response, (b) => b.includes('allowed'));

    expect(buffer).not.toContain('evt-1');
    expect(buffer).toContain('allowed');
    abort();
  });

  it('applies audience.users on the REPLAY path, not just the live one', async () => {
    // Regression: replay read the outbox directly and ran only the permission
    // half of the gate, so a durable event addressed to another user was
    // delivered to anyone in the scope who reconnected with a Last-Event-ID —
    // and lastEventId is client-supplied, so it was requestable on demand.
    const hub = createEventHub();
    const readSince = vi.fn(async () => [
      { ...durable(41), id: 'for-someone-else', audience: { users: ['u2'] } },
      { ...durable(42), id: 'for-me', audience: { users: ['u1'] } },
      { ...durable(43), id: 'for-everyone' },
    ]);
    const { handler } = createEventStreamHandler({
      hub,
      resolveSubscriber: () => subscriber, // subscriberId 'u1'
      store: { readSince },
    });
    const { req, abort } = request({ 'last-event-id': '44' });
    const response = await handler(req);

    const buffer = await readUntil(response, (b) => b.includes('for-everyone'));
    expect(buffer).not.toContain('for-someone-else');
    expect(buffer).toContain('for-me');
    expect(buffer).toContain('for-everyone');
    abort();
  });

  it('withholds permission-carrying replayed events the same way the live path does', async () => {
    const hub = createEventHub();
    const readSince = vi.fn(async () => [
      { ...durable(41), id: 'replay-denied', audience: { permission: 'denied' } },
      { ...durable(42), id: 'replay-granted', audience: { permission: 'granted' } },
    ]);
    const { handler } = createEventStreamHandler({
      hub,
      resolveSubscriber: () => ({ ...subscriber, can: (p: unknown) => p === 'granted' }),
      store: { readSince },
    });
    const { req, abort } = request({ 'last-event-id': '43' });
    const response = await handler(req);

    const buffer = await readUntil(response, (b) => b.includes('replay-granted'));
    expect(buffer).not.toContain('replay-denied');
    abort();
  });

  it('closes the stream at the connection age cap', async () => {
    vi.useFakeTimers();
    try {
      const hub = createEventHub();
      const { handler, metrics } = createEventStreamHandler({
        hub,
        resolveSubscriber: () => subscriber,
        maxConnectionAgeMs: 1_000,
        heartbeatMs: 0,
      });
      const response = await handler(request().req);
      expect(metrics.connections()).toBe(1);
      vi.advanceTimersByTime(1_100);
      expect(metrics.connections()).toBe(0);
      // Stream is closed — reading completes.
      const reader = response.body!.getReader();
      // Drain the retry frame, then expect done.
      await reader.read();
      const end = await reader.read();
      expect(end.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
