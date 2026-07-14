/**
 * Settings routes.
 *
 * `GET` never 404s on an unset key: `readAll()` applies the Zod `.default(...)`
 * from the config schema, so a table with zero rows still reads back a complete,
 * valid settings object. `PUT` validates through the same schema — the write is
 * rejected as a whole before anything is persisted if any value fails.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet } from '@octabits-io/framework/elysia';
import type { DemoScopePlugin } from '../request-scope.ts';
import { hasPermission } from '../rbac.ts';

const SCHEMA_SETTINGS = z.object({
  supportEmail: z.email(),
  welcomeSubject: z.string(),
});

export function createSettingsRoutes(scopePlugin: DemoScopePlugin) {
  // `settingsService` resolves from `ctx.scope`, where the request scope
  // re-registers it as Scoped (see container.ts): the service's read cache is
  // per-unit-of-work, and the request scope makes the request that unit — one
  // instance per request, disposed with the scope, never stale across requests.
  return new Elysia({ prefix: '/settings', tags: ['Settings'] })
    .use(scopePlugin)
    .get(
      '/',
      async ({ scope }) => {
        const config = await scope.resolve('settingsService').readAll();
        return config as z.infer<typeof SCHEMA_SETTINGS>;
      },
      {
        response: { 200: SCHEMA_SETTINGS, ...errorResponses(429, 500) },
        detail: { summary: 'Read settings (schema defaults applied for unset keys)' },
      },
    )
    .put(
      '/',
      async ({ body, set, scope }) => {
        if (!hasPermission(scope.resolve('role'), { settings: ['write'] })) {
          return statusErrorWithSet(set, {
            key: 'forbidden',
            message: 'Role is not permitted to write settings',
          });
        }
        // One scoped instance for both calls: the write invalidates the same
        // cache the readAll below then re-populates.
        const settings = scope.resolve('settingsService');
        const written = await settings.writeConfig(body);
        if (!written.ok) return statusErrorWithSet(set, written.error);
        const config = await settings.readAll();
        return config as z.infer<typeof SCHEMA_SETTINGS>;
      },
      {
        body: SCHEMA_SETTINGS.partial(),
        response: { 200: SCHEMA_SETTINGS, ...errorResponses(400, 403, 429, 500) },
        detail: { summary: 'Update settings (requires the admin demo role)' },
      },
    );
}
