import { describe, it, expect, vi } from 'vitest';
import { Elysia } from 'elysia';
import type { Logger } from '../logger/index.ts';
import { ok, err } from '../result/index.ts';
import type { OctError, Result } from '../result/index.ts';
import { createBearerAuthPlugin, type BearerTokenValidator } from './bearer-auth';
import { createErrorHandler } from './errors';

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
 * Builds the app with no casts on purpose: `validatedToken` below is typed
 * purely by inference from `authService`, so this compiling *is* the assertion
 * that the token generic flows into the route context.
 */
function appWith(options: Parameters<typeof createBearerAuthPlugin<TestToken>>[0]) {
  return new Elysia()
    .use(createErrorHandler(silentLogger, { production: false }))
    .use(createBearerAuthPlugin(options))
    .get('/me', ({ validatedToken }) => ({ subject: validatedToken.subject }));
}

describe('createBearerAuthPlugin', () => {
  it('exposes the validated token on the context and passes the header through', async () => {
    const validateAuthorizationHeader = vi.fn(async () => ok(VALID_TOKEN));
    const app = appWith({ authService: { validateAuthorizationHeader } });

    const res = await app.handle(new Request('http://localhost/me', {
      headers: { authorization: 'Bearer good-token' },
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: 'user-1' });
    expect(validateAuthorizationHeader).toHaveBeenCalledWith('Bearer good-token');
  });

  it('passes undefined (not null) when the header is absent', async () => {
    const validateAuthorizationHeader = vi.fn(async () => ok(VALID_TOKEN));
    const app = appWith({ authService: { validateAuthorizationHeader } });

    await app.handle(new Request('http://localhost/me'));

    expect(validateAuthorizationHeader).toHaveBeenCalledWith(undefined);
  });

  it('maps a validation failure to 401, preserving the error key and message', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'invalid_token', message: 'signature mismatch' })),
    });

    const res = await app.handle(new Request('http://localhost/me'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ key: 'invalid_token', message: 'signature mismatch' });
  });

  it('maps jwks_unavailable to 503 service_unavailable, keeping the message', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'jwks_unavailable', message: 'jwks endpoint timed out' })),
    });

    const res = await app.handle(new Request('http://localhost/me'));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ key: 'service_unavailable', message: 'jwks endpoint timed out' });
  });

  it('honors statusOverrides over the built-in key rules', async () => {
    const app = appWith({
      authService: stubAuthService(err({ key: 'jwks_unavailable', message: 'down' })),
      statusOverrides: { jwks_unavailable: 401 },
    });

    expect((await app.handle(new Request('http://localhost/me'))).status).toBe(401);
  });

  it('rejects with 403 when authorize returns false', async () => {
    const app = appWith({
      authService: stubAuthService(ok(VALID_TOKEN)),
      authorize: (token) => token.admin,
    });

    const res = await app.handle(new Request('http://localhost/me', {
      headers: { authorization: 'Bearer good-token' },
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ key: 'forbidden', message: 'Forbidden' });
  });

  it('passes the token and request context to authorize, and allows on true', async () => {
    const authorize = vi.fn(() => true);
    const app = appWith({
      authService: stubAuthService(ok({ subject: 'user-1', admin: true })),
      authorize,
    });

    const res = await app.handle(new Request('http://localhost/me', {
      headers: { authorization: 'Bearer good-token' },
    }));

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

    await app.handle(new Request('http://localhost/me'));

    expect(authorize).not.toHaveBeenCalled();
  });

  it('exposes the token under a custom contextKey', async () => {
    // No cast: `currentUser` is typed by contextKey inference alone.
    const app = new Elysia()
      .use(createBearerAuthPlugin({
        authService: stubAuthService(ok(VALID_TOKEN)),
        contextKey: 'currentUser',
      }))
      .get('/who', ({ currentUser }) => ({ subject: currentUser.subject }));

    const res = await app.handle(new Request('http://localhost/who', {
      headers: { authorization: 'Bearer good-token' },
    }));

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

      const res = await app.handle(new Request('http://localhost/me'));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'down' } });
    });

    it('receives the resolved status and the original error verbatim', async () => {
      const onUnauthorized = vi.fn(() => new Response('x', { status: 401 }));
      const app = appWith({
        authService: stubAuthService(err({ key: 'invalid_token', message: 'bad sig' })),
        onUnauthorized,
      });

      await app.handle(new Request('http://localhost/me'));

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

      const res = await app.handle(new Request('http://localhost/me', {
        headers: { authorization: 'Bearer good-token' },
      }));

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
      const app = new Elysia()
        .onError({ as: 'global' }, ({ error, set }) => {
          if (error instanceof JsonRpcAuthError) {
            set.status = 418;
            return { rpcCode: error.rpcCode };
          }
          return undefined;
        })
        .use(createBearerAuthPlugin({
          authService: stubAuthService(err({ key: 'invalid_token', message: 'x' })),
          onUnauthorized: () => new JsonRpcAuthError(-32001),
        }))
        .get('/me', () => ({ reached: true }));

      const res = await app.handle(new Request('http://localhost/me'));

      expect(res.status).toBe(418);
      expect(await res.json()).toEqual({ rpcCode: -32001 });
    });

    it('never reaches the handler when rejecting', async () => {
      const handler = vi.fn(() => ({ reached: true }));
      const app = new Elysia()
        .use(createBearerAuthPlugin({
          authService: stubAuthService(err({ key: 'invalid_token', message: 'x' })),
          onUnauthorized: () => new Response('denied', { status: 401 }),
        }))
        .get('/me', handler);

      await app.handle(new Request('http://localhost/me'));

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
