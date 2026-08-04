/**
 * SPIKE (elysia-exit-option): `../elysia/bearer-auth.test.ts` ported
 * case-for-case. The rejection seam is Hono-native (return a `Response`)
 * instead of throw-based; every status/body assertion is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Logger } from '../logger/index.ts';
import { ok, err } from '../result/index.ts';
import type { OctError, Result } from '../result/index.ts';
import { createBearerAuthMiddleware, type BearerAuthEnv } from './bearer-auth';
import { createHonoApp } from './create-app';
import type { BearerTokenValidator } from '../server/bearer-auth';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

interface TestToken {
  subject: string;
  admin: boolean;
}

/** Minimal stand-in for `…/auth`'s createBearerAuthService (structural seam). */
function stubAuthService(
  result: Result<TestToken, OctError> | (() => Result<TestToken, OctError>),
): BearerTokenValidator<TestToken> {
  return {
    validateAuthorizationHeader: async () => (typeof result === 'function' ? result() : result),
  };
}

const VALID_TOKEN: TestToken = { subject: 'user-1', admin: false };

/**
 * NOTE vs the Elysia suite: there, `validatedToken` typing was *inferred* from
 * the plugin chain and "compiling is the assertion". On Hono the Env is
 * *declared* on the app — `c.get('validatedToken')` types against
 * `BearerAuthEnv<TestToken>`, but the compiler does not prove the middleware
 * is mounted. See the spike findings.
 */
function appWith(options: Parameters<typeof createBearerAuthMiddleware<TestToken>>[0]) {
  const routes = new Hono<BearerAuthEnv<TestToken>>()
    .use(createBearerAuthMiddleware(options))
    .get('/me', (c) => c.json({ subject: c.get('validatedToken').subject }));
  return createHonoApp(routes, { logger: silentLogger, securityHeaders: false, errorHandler: { production: false } });
}

describe('createBearerAuthMiddleware', () => {
  it('exposes the validated token on the context and passes the header through', async () => {
    const validateAuthorizationHeader = vi.fn(async () => ok(VALID_TOKEN));
    const app = appWith({ authService: { validateAuthorizationHeader } });

    const res = await app.request('/me', { headers: { authorization: 'Bearer good-token' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: 'user-1' });
    expect(validateAuthorizationHeader).toHaveBeenCalledWith('Bearer good-token');
  });

  it('passes undefined (not null) when the header is absent', async () => {
    const validateAuthorizationHeader = vi.fn(async () => ok(VALID_TOKEN));
    const app = appWith({ authService: { validateAuthorizationHeader } });

    await app.request('/me');

    expect(validateAuthorizationHeader).toHaveBeenCalledWith(undefined);
  });

  it('maps a validation failure to 401, preserving the error key and message', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'invalid_token', message: 'signature mismatch' })),
    });

    const res = await app.request('/me');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ key: 'invalid_token', message: 'signature mismatch' });
  });

  it('maps jwks_unavailable to 503 service_unavailable, keeping the message', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'jwks_unavailable', message: 'jwks endpoint timed out' })),
    });

    const res = await app.request('/me');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ key: 'service_unavailable', message: 'jwks endpoint timed out' });
  });

  it('honors statusOverrides over the built-in key rules', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'jwks_unavailable', message: 'down' })),
      statusOverrides: { jwks_unavailable: 401 },
    });

    expect((await app.request('/me')).status).toBe(401);
  });

  it('rejects with 403 when authorize returns false', async () => {
    const app = appWith({
      authService: stubAuthService(ok(VALID_TOKEN)),
      authorize: (token) => token.admin,
    });

    const res = await app.request('/me', { headers: { authorization: 'Bearer good-token' } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ key: 'forbidden', message: 'Forbidden' });
  });

  it('passes the token and request context to authorize, and allows on true', async () => {
    const authorize = vi.fn(() => true);
    const app = appWith({
      authService: stubAuthService(ok({ subject: 'user-1', admin: true })),
      authorize,
    });

    const res = await app.request('/me', { headers: { authorization: 'Bearer good-token' } });

    expect(res.status).toBe(200);
    expect(authorize).toHaveBeenCalledWith(
      { subject: 'user-1', admin: true },
      expect.objectContaining({ request: expect.any(Request), path: '/me' }),
    );
  });

  it('does not run authorize when validation already failed', async () => {
    const authorize = vi.fn(() => true);
    const app = appWith({
      authService: stubAuthService(err({ key: 'invalid_token', message: 'nope' })),
      authorize,
    });

    await app.request('/me');

    expect(authorize).not.toHaveBeenCalled();
  });

  it('exposes the token under a custom contextKey', async () => {
    const app = new Hono<BearerAuthEnv<TestToken, 'currentUser'>>()
      .use(createBearerAuthMiddleware({
        authService: stubAuthService(ok(VALID_TOKEN)),
        contextKey: 'currentUser',
      }))
      .get('/who', (c) => c.json({ subject: c.get('currentUser').subject }));

    const res = await app.request('/who', { headers: { authorization: 'Bearer good-token' } });

    expect(await res.json()).toEqual({ subject: 'user-1' });
  });

  describe('onUnauthorized', () => {
    it('short-circuits with a Response returned by the hook (the JSON-RPC-envelope case)', async () => {
      const app = appWith({
        authService: stubAuthService(err({ key: 'jwks_unavailable', message: 'down' })),
        onUnauthorized: ({ status, error }) => new Response(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: error.message } }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
      });

      const res = await app.request('/me');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'down' } });
    });

    it('receives the resolved status and the original error verbatim', async () => {
      const onUnauthorized = vi.fn(() => new Response('x', { status: 401 }));
      const app = appWith({
        authService: stubAuthService(err({ key: 'invalid_token', message: 'bad sig' })),
        onUnauthorized,
      });

      await app.request('/me');

      expect(onUnauthorized).toHaveBeenCalledWith(
        { status: 401, error: { key: 'invalid_token', message: 'bad sig' } },
        expect.objectContaining({ path: '/me' }),
      );
    });

    it('is used for authorize rejections too, with the synthetic forbidden error', async () => {
      const onUnauthorized = vi.fn(() => new Response('nope', { status: 403 }));
      const app = appWith({
        authService: stubAuthService(ok(VALID_TOKEN)),
        authorize: () => false,
        onUnauthorized,
      });

      const res = await app.request('/me', { headers: { authorization: 'Bearer good-token' } });

      expect(res.status).toBe(403);
      expect(onUnauthorized).toHaveBeenCalledWith(
        { status: 403, error: { key: 'forbidden', message: 'Forbidden' } },
        expect.anything(),
      );
    });

    it('throws a returned Error, so a custom error handler can map it', async () => {
      class JsonRpcAuthError extends Error {
        constructor(public rpcCode: number) { super('rpc auth failure'); }
      }
      const app = new Hono<BearerAuthEnv<TestToken>>();
      app.onError((error, c) => {
        if (error instanceof JsonRpcAuthError) return c.json({ rpcCode: error.rpcCode }, 418);
        throw error;
      });
      app
        .use(createBearerAuthMiddleware<TestToken>({
          authService: stubAuthService(err({ key: 'invalid_token', message: 'x' })),
          onUnauthorized: () => new JsonRpcAuthError(-32001),
        }))
        .get('/me', (c) => c.json({ reached: true }));

      const res = await app.request('/me');

      expect(res.status).toBe(418);
      expect(await res.json()).toEqual({ rpcCode: -32001 });
    });

    it('never reaches the handler when rejecting', async () => {
      let reached = false;
      const app = new Hono()
        .use(createBearerAuthMiddleware({
          authService: stubAuthService(err({ key: 'invalid_token', message: 'x' })),
          onUnauthorized: () => new Response('denied', { status: 401 }),
        }))
        .get('/me', (c) => { reached = true; return c.json({ reached }); });

      await app.request('/me');

      expect(reached).toBe(false);
    });
  });
});
