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
import type { IoC } from '@octabits-io/framework/ioc';
import type { DemoServices } from '../container.ts';
import { hasPermission } from '../rbac.ts';

const SCHEMA_SETTINGS = z.object({
  supportEmail: z.email(),
  welcomeSubject: z.string(),
});

export function createSettingsRoutes(container: IoC<DemoServices>) {
  // Resolved per call, not once per route module: the service is registered
  // Transient because its read cache is scoped to one unit of work (see
  // container.ts), so each request must get its own instance.
  const settings = () => container.resolve('settingsService');

  return new Elysia({ prefix: '/settings', tags: ['Settings'] })
    .get(
      '/',
      async () => {
        const config = await settings().readAll();
        return config as z.infer<typeof SCHEMA_SETTINGS>;
      },
      {
        response: { 200: SCHEMA_SETTINGS, ...errorResponses(429, 500) },
        detail: { summary: 'Read settings (schema defaults applied for unset keys)' },
      },
    )
    .put(
      '/',
      async ({ body, set, headers }) => {
        if (!hasPermission(headers['x-demo-role'], { settings: ['write'] })) {
          return statusErrorWithSet(set, {
            key: 'forbidden',
            message: 'Role is not permitted to write settings',
          });
        }
        const written = await settings().writeConfig(body);
        if (!written.ok) return statusErrorWithSet(set, written.error);
        const config = await settings().readAll();
        return config as z.infer<typeof SCHEMA_SETTINGS>;
      },
      {
        body: SCHEMA_SETTINGS.partial(),
        response: { 200: SCHEMA_SETTINGS, ...errorResponses(400, 403, 429, 500) },
        detail: { summary: 'Update settings (requires the admin demo role)' },
      },
    );
}
