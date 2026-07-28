/**
 * `@octabits-io/framework/elysia/events` — the `.use()`-style Elysia wrapper
 * over `@octabits-io/framework/events`' {@link createEventStreamHandler}.
 *
 * The handler itself is a plain fetch handler on purpose (it spends no Elysia
 * type budget and emits no Eden types — the stream is consumed by an SSE
 * reader, not an API client). Prefer registering it with `.mount()` when your
 * route chain is anywhere near TypeScript's recursion limit:
 *
 * ```ts
 * const { handler } = createEventStreamHandler({ hub, resolveSubscriber });
 * app.mount('/events', handler);
 * ```
 *
 * This wrapper exists for consumers that want conventional plugin
 * registration instead. The prefix is a **literal generic** (the
 * `./elysia/flow` convention): a plain `string` would collapse the emitted
 * route key to an index signature.
 *
 * ```ts
 * app.use(createEventStreamRoute({ prefix: '/events', hub, resolveSubscriber }));
 * ```
 */
import { Elysia } from 'elysia';
import {
  createEventStreamHandler,
  type CreateEventStreamHandlerDeps,
} from '../events/index.ts';

export type CreateEventStreamRouteOptions<TPrefix extends string> = CreateEventStreamHandlerDeps & {
  /** Route prefix. Default `'/events'`. Typed as a literal on purpose. */
  prefix?: TPrefix;
};

export function createEventStreamRoute<TPrefix extends string = '/events'>(
  options: CreateEventStreamRouteOptions<TPrefix>,
) {
  const { prefix, ...handlerDeps } = options;
  const { handler } = createEventStreamHandler(handlerDeps);
  return new Elysia({ prefix: (prefix ?? '/events') as TPrefix })
    // '' (not '/'): under a prefixed parent, prefix + '/' only matches the
    // trailing-slash form; '' matches the exact prefix path in both layouts.
    .get('', ({ request }) => handler(request));
}
