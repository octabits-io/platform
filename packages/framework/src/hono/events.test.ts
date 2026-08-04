/**
 * Events sub-app wrapper: the SSE handler round-trips through Hono routing
 * (headers prove the real handler answered — the full stream semantics are
 * covered in the events module's own suite).
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createEventHub } from '../events/hub.ts';
import { createEventStreamApp } from './events';

describe('createEventStreamApp', () => {
  it('serves the SSE stream at the mount path', async () => {
    const app = new Hono().route(
      '/events',
      createEventStreamApp({
        hub: createEventHub(),
        resolveSubscriber: () => ({ scopeKey: 'scope-a', subscriberId: 'u1' }),
      }),
    );

    const controller = new AbortController();
    const response = await app.fetch(
      new Request('http://localhost/events', { signal: controller.signal }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
  });

  it('propagates the handler’s auth rejection', async () => {
    const app = new Hono().route(
      '/events',
      createEventStreamApp({
        hub: createEventHub(),
        resolveSubscriber: () => null,
      }),
    );

    const response = await app.fetch(new Request('http://localhost/events'));
    expect(response.status).toBe(401);
  });
});
