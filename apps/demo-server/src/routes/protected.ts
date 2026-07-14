/**
 * Bearer-authenticated routes — `createBearerAuthPlugin` (`…/elysia`) over the
 * API-key service from `../api-keys.ts`.
 *
 * The plugin owns the branch every consumer otherwise re-implements: read the
 * `Authorization` header, validate, map `jwks_unavailable` → 503 and every
 * other failure → 401 (key/message preserved), and expose the typed token as
 * `ctx.validatedToken`. Compare with the `x-demo-role` header used by the
 * contacts/settings routes: that header is a stand-in for a *validated* claim,
 * and this group is what the validated version looks like.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { createBearerAuthPlugin, errorResponses } from '@octabits-io/framework/elysia';
import type { DemoApiKeys } from '../api-keys.ts';

const SCHEMA_WHOAMI = z.object({
  keyId: z.string(),
  label: z.string(),
  role: z.enum(['admin', 'viewer']),
});

export function createProtectedRoutes(apiKeys: DemoApiKeys) {
  return new Elysia({ prefix: '/protected', tags: ['Protected'] })
    .use(createBearerAuthPlugin({ authService: apiKeys.authService }))
    .get(
      '/whoami',
      ({ validatedToken }) => validatedToken,
      {
        response: { 200: SCHEMA_WHOAMI, ...errorResponses(401, 429, 500) },
        detail: { summary: 'Identify the API key on the Authorization header' },
      },
    );
}
