/**
 * Bearer-authenticated routes — `createBearerAuthMiddleware` (`…/hono`) over
 * the API-key service from `../api-keys.ts`.
 *
 * The middleware owns the branch every consumer otherwise re-implements: read
 * the `Authorization` header, validate, map `jwks_unavailable` → 503 and every
 * other failure → 401 (key/message preserved), and expose the typed token as
 * `c.get('validatedToken')`. Compare with the `x-demo-role` header used by the
 * contacts/settings routes: that header is a stand-in for a *validated* claim,
 * and this group is what the validated version looks like.
 *
 * It goes through `createRouteModule` for the same reason the scoped modules
 * do — `c.get('validatedToken')` is only typed off a declared `Env`, and the
 * factory is what ties that declaration to the middleware actually being
 * mounted.
 */
import { z } from 'zod';
import { errorResponses } from '@octabits-io/framework/server';
import { createBearerAuthMiddleware, createRouteModule } from '@octabits-io/framework/hono';
import { describeApiRoute } from '@octabits-io/framework/hono/openapi';
import type { ApiKeyToken, DemoApiKeys } from '../api-keys.ts';

const SCHEMA_WHOAMI = z.object({
  keyId: z.string(),
  label: z.string(),
  role: z.enum(['admin', 'viewer']),
});

export function createProtectedRoutes(apiKeys: DemoApiKeys) {
  return createRouteModule(
    { middleware: [createBearerAuthMiddleware<ApiKeyToken>({ authService: apiKeys.authService })] },
    (app) =>
      app.get(
        '/whoami',
        describeApiRoute({
          summary: 'Identify the API key on the Authorization header',
          tags: ['Protected'],
          responses: { 200: SCHEMA_WHOAMI, ...errorResponses(401, 429, 500) },
        }),
        (c) => c.json(c.get('validatedToken')),
      ),
  );
}
