/**
 * Per-request IoC scope (`…/hono`'s `createRequestScopeMiddleware` + `…/ioc`).
 *
 * Every request gets a scoped child container as `c.get('scope')`. The
 * middleware owns the whole lifecycle in ONE wrapping hook — Elysia needed a
 * `resolve`/`onAfterResponse`/`onError` triangle for the same guarantee — so
 * nothing here, or in any route, worries about leaks or double-dispose:
 * `commit: true` on success, `commit: false` on a handler error or a guard
 * rejection.
 *
 * What this app seeds per request (see `createDemoRequestScope`):
 *  - `role` — the `x-demo-role` header, stand-in for a validated JWT claim.
 *  - `settingsService` — a *Scoped override* of the root's Transient
 *    registration: the service caches reads for one unit of work, and the
 *    request is exactly that unit. Within one request every resolve shares the
 *    instance (PUT settings writes then reads through one warm cache); across
 *    requests the cache never goes stale.
 *
 * The `guard` rejects unknown roles before any handler runs — thrown after the
 * scope exists, which is precisely the case the middleware disposes for you.
 *
 * `DemoScopeEnv` is the Hono `Env` contribution. Route files never declare it
 * by hand: they go through `createRouteModule`, which only hands out a builder
 * app once the matching middleware has been supplied — Hono types `c.get()`
 * off a DECLARED `Env` and cannot otherwise prove the middleware is mounted.
 */
import { createRequestScopeMiddleware, type RequestScopeEnv } from '@octabits-io/framework/hono';
import { BadRequestError } from '@octabits-io/framework/server';
import type { IoC } from '@octabits-io/framework/ioc';
import type { Logger } from '@octabits-io/framework/logger';
import {
  createDemoRequestScope,
  type DemoRequestServices,
  type DemoServices,
} from './container.ts';
import { DEMO_ROLES } from './rbac.ts';

/** The per-request scope handed to route handlers. */
export type DemoScope = IoC<DemoRequestServices & DemoServices>;

/** The Env contribution — `c.get('scope')` typed as the demo's request scope. */
export type DemoScopeEnv = RequestScopeEnv<DemoScope>;

export function createDemoScopeMiddleware(container: IoC<DemoServices>, logger: Logger) {
  return createRequestScopeMiddleware<DemoScope>({
    createScope: ({ request }) => createDemoRequestScope(container, request),
    guard: (scope) => {
      const role = scope.resolve('role');
      if (role !== undefined && !DEMO_ROLES.includes(role)) {
        throw new BadRequestError(
          `Unknown demo role '${role}' — expected one of: ${DEMO_ROLES.join(', ')}`,
          'invalid_demo_role',
        );
      }
    },
    logger,
  });
}

/** Route factories take this to get `c.get('scope')` typed in their handlers. */
export type DemoScopeMiddleware = ReturnType<typeof createDemoScopeMiddleware>;
