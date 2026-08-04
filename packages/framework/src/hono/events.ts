/**
 * `@octabits-io/framework/hono/…` events glue — the sub-app wrapper over
 * `@octabits-io/framework/events`' {@link createEventStreamHandler}.
 *
 * The handler itself is a plain fetch handler on purpose (the stream is
 * consumed by an SSE reader, not an API client, and spends no route-type
 * budget). On Hono, either register it directly:
 *
 * ```ts
 * const { handler } = createEventStreamHandler({ hub, resolveSubscriber });
 * app.mount('/events/stream', handler);            // fetch-first (preferred)
 * ```
 *
 * …or mount this wrapper for conventional sub-app registration:
 *
 * ```ts
 * app.route('/events', createEventStreamApp({ hub, resolveSubscriber }));
 * ```
 */
import { Hono } from 'hono';
import {
  createEventStreamHandler,
  type CreateEventStreamHandlerDeps,
} from '../events/index.ts';

export function createEventStreamApp(deps: CreateEventStreamHandlerDeps) {
  const { handler } = createEventStreamHandler(deps);
  return new Hono().get('/', (c) => handler(c.req.raw));
}
