/**
 * Event routes — the demo consumer of `@octabits-io/framework/events`.
 *
 * Two surfaces:
 *
 * - `POST /api/events/demo` — emit a demo event on either lane. The durable
 *   emit runs inside a real transaction (the documented pattern: state change
 *   + outbox row commit together; NOTIFY fires at COMMIT).
 * - `GET /api/events/stream` — the SSE endpoint, registered with `app.mount()`
 *   (see {@link createEventStreamMount}): the handler is a plain fetch handler
 *   on purpose, spending no route-type budget and emitting no client types —
 *   browsers consume it with the kit's fetch-based SSE reader
 *   (`@octabits-io/nuxt-ui-kit/events`), not an API client.
 *
 *   Fetch-first matters more on Hono than it did on Elysia: the request-scope
 *   middleware disposes its scope *before* the `Response` is returned, so a
 *   long-lived stream must live outside that middleware — which `.mount()`
 *   gives for free. (`…/hono/events`' `createEventStreamApp` is the
 *   `app.route()`-shaped alternative; the mount stays here because it is the
 *   pattern worth documenting.)
 *
 * Auth on the stream is the injected `resolveSubscriber` seam. The demo binds
 * a deliberately trivial resolution (subscriber id from `?user=`, everything
 * permitted); a real consumer binds its bearer validation here and returns
 * `null` to 401.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createEventStreamHandler } from '@octabits-io/framework/events';
import type { IoC } from '@octabits-io/framework/ioc';
import { successResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import type { DemoServices } from '../container.ts';
import { DEMO_EVENT_SCOPE } from '../container.ts';

const SCHEMA_EMIT = z.object({
  lane: z.enum(['durable', 'ephemeral']),
  message: z.string().max(200).default('hello from the demo'),
});

const SCHEMA_EMITTED = z.object({
  id: z.string(),
  seq: z.number().optional(),
  lane: z.enum(['durable', 'ephemeral']),
  type: z.string(),
});

/** The SSE fetch handler for `app.mount()` — see the module doc. */
export function createEventStreamMount(container: IoC<DemoServices>) {
  const { handler } = createEventStreamHandler({
    hub: container.resolve('eventHub'),
    store: container.resolve('eventOutboxStore'),
    logger: container.resolve('logger'),
    resolveSubscriber: (request) => ({
      scopeKey: DEMO_EVENT_SCOPE,
      subscriberId: new URL(request.url).searchParams.get('user') ?? 'demo-user',
      can: () => true,
    }),
  });
  return handler;
}

export function createEventRoutes(container: IoC<DemoServices>) {
  return new Hono().post(
    '/demo',
    describeApiRoute({
      summary: 'Emit a demo event on the chosen lane',
      tags: ['Events'],
      responses: successResponses(200, SCHEMA_EMITTED),
    }),
    octApiValidator('json', SCHEMA_EMIT),
    async (c) => {
      const body = c.req.valid('json');
      const publisher = container.resolve('eventPublisher');
      const envelope =
        body.lane === 'durable'
          ? // The documented durable pattern: emit inside the transaction that
            // carries the state change (here the outbox row is the only write,
            // but the shape is the point).
            await container
              .resolve('db')
              .transaction((tx) => publisher.emit(demoEvent('durable', body.message), tx))
          : await publisher.emit(demoEvent('ephemeral', body.message));
      return c.json({ id: envelope.id, seq: envelope.seq, lane: envelope.lane, type: envelope.type });
    },
  );
}

function demoEvent(lane: 'durable' | 'ephemeral', message: string) {
  // `const type` keeps the literal union — the publisher is parameterized
  // over DemoEventMap, so a type outside the map (or a payload of the wrong
  // shape) is a compile error here and a throw at runtime.
  const type = lane === 'durable' ? ('demo.message.recorded' as const) : ('demo.signal.pinged' as const);
  return {
    type,
    scopeKey: DEMO_EVENT_SCOPE,
    lane,
    data: { message },
    actor: { type: 'system' as const, name: 'demo' },
  };
}
