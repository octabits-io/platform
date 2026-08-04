/**
 * Settings routes.
 *
 * `GET` never 404s on an unset key: `readAll()` applies the Zod `.default(...)`
 * from the config schema, so a table with zero rows still reads back a complete,
 * valid settings object. `PUT` validates through the same schema — the write is
 * rejected as a whole before anything is persisted if any value fails.
 */
import { z } from 'zod';
import { errorResponses } from '@octabits-io/framework/server';
import { createRouteModule } from '@octabits-io/framework/hono';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { errorJson } from '../http.ts';
import type { DemoScopeMiddleware } from '../request-scope.ts';
import { hasPermission } from '../rbac.ts';

const SCHEMA_SETTINGS = z.object({
  supportEmail: z.email(),
  welcomeSubject: z.string(),
});

const TAGS = ['Settings'];

export function createSettingsRoutes(scopeMiddleware: DemoScopeMiddleware) {
  // `settingsService` resolves from `c.get('scope')`, where the request scope
  // re-registers it as Scoped (see container.ts): the service's read cache is
  // per-unit-of-work, and the request scope makes the request that unit — one
  // instance per request, disposed with the scope, never stale across requests.
  return createRouteModule({ middleware: [scopeMiddleware] }, (app) =>
    app
      .get(
        '/',
        describeApiRoute({
          summary: 'Read settings (schema defaults applied for unset keys)',
          tags: TAGS,
          responses: { 200: SCHEMA_SETTINGS, ...errorResponses(429, 500) },
        }),
        async (c) => {
          const config = await c.get('scope').resolve('settingsService').readAll();
          return c.json(config as z.infer<typeof SCHEMA_SETTINGS>);
        },
      )
      .put(
        '/',
        describeApiRoute({
          summary: 'Update settings (requires the admin demo role)',
          tags: TAGS,
          responses: { 200: SCHEMA_SETTINGS, ...errorResponses(400, 403, 429, 500) },
        }),
        octApiValidator('json', SCHEMA_SETTINGS.partial()),
        async (c) => {
          const scope = c.get('scope');
          if (!hasPermission(scope.resolve('role'), { settings: ['write'] })) {
            return errorJson(c, { key: 'forbidden', message: 'Role is not permitted to write settings' });
          }
          // One scoped instance for both calls: the write invalidates the same
          // cache the readAll below then re-populates.
          const settings = scope.resolve('settingsService');
          const written = await settings.writeConfig(c.req.valid('json'));
          if (!written.ok) return errorJson(c, written.error);
          const config = await settings.readAll();
          return c.json(config as z.infer<typeof SCHEMA_SETTINGS>);
        },
      ),
  );
}
