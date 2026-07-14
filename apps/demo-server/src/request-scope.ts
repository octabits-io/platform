/**
 * Per-request IoC scope (`…/elysia`'s `createRequestScopePlugin` + `…/ioc`).
 *
 * Every request gets a scoped child container as `ctx.scope`. The plugin owns
 * the lifecycle triangle (dispose on success with `commit: true`, on handler
 * error and guard rejection with `commit: false`), so nothing here — or in any
 * route — worries about leaks or double-dispose.
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
 * scope exists, which is precisely the case the plugin disposes for you.
 */
import { createRequestScopePlugin, BadRequestError } from '@octabits-io/framework/elysia';
import type { IoC } from '@octabits-io/framework/ioc';
import type { Logger } from '@octabits-io/framework/logger';
import { createDemoRequestScope, type DemoServices } from './container.ts';
import { DEMO_ROLES } from './rbac.ts';

export function createDemoScopePlugin(container: IoC<DemoServices>, logger: Logger) {
  return createRequestScopePlugin({
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

/** Route factories take this to get `ctx.scope` typed in their handlers. */
export type DemoScopePlugin = ReturnType<typeof createDemoScopePlugin>;
