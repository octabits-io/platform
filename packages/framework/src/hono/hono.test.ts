/**
 * Assembly-level suite — error handler over
 * the shared `resolveErrorResponse` core, `@hono/zod-validator` failures
 * mapped into the standard VALIDATION body, security headers on success AND
 * error paths, health trio, `createHonoApp` composition, and the
 * framework-agnostic SSE handler round-tripping through `app.mount()`.
 *
 * Several cases drive the app through `../server/testing`'s `testRequest` via
 * the one-line `testableHonoApp` adapter, exercising the harness's structural
 * `{ handle(Request) }` contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Logger } from '../logger/index.ts';
import { testRequest } from '../server/testing';
import { createEventHub } from '../events/hub.ts';
import { createEventStreamHandler } from '../events/sse.ts';
import type { EventEnvelope } from '../events/types.ts';
import { ApiError, NotFoundError, statusErrorWithSet } from '../server/errors';
import { registerErrorHandler, octValidator, RequestValidationError } from './errors';
import { createSecurityHeadersMiddleware } from './security-headers';
import { createHealthApp } from './health';
import { createHonoApp } from './create-app';
import { testableHonoApp } from './testing';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

describe('registerErrorHandler', () => {
  function appWith(routes: Hono, production = false) {
    return registerErrorHandler(routes, silentLogger, { production });
  }

  it('maps ApiError to its status + body', async () => {
    const app = appWith(new Hono().get('/x', () => { throw new ApiError(409, 'already_done', 'twice'); }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/x');
    expect(res.status).toBe(409);
    expect(res.data).toEqual({ key: 'already_done', message: 'twice' });
  });

  it('maps DB connection errors to 503', async () => {
    const dbError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const app = appWith(new Hono().get('/db', () => { throw dbError; }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/db');
    expect(res.status).toBe(503);
    expect(res.data).toEqual({ key: 'service_unavailable', message: 'Service temporarily unavailable' });
  });

  it('hides internal messages in production', async () => {
    const app = appWith(new Hono().get('/oops', () => { throw new Error('secret stack detail'); }), true);
    const res = await testRequest(testableHonoApp(app), 'GET', '/oops');
    expect(res.status).toBe(500);
    expect(res.data).toEqual({ key: 'internal_server_error', message: 'Internal Server Error' });
  });

  it('keeps 4xx ApiError messages in production', async () => {
    const app = appWith(new Hono().get('/gone', () => { throw new NotFoundError('thing is gone', 'thing_not_found'); }), true);
    const res = await testRequest(testableHonoApp(app), 'GET', '/gone');
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ key: 'thing_not_found', message: 'thing is gone' });
  });

  it('logs 5xx ApiErrors (the redacted response is otherwise the only trace)', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const app = registerErrorHandler(
      new Hono().get('/x', () => { throw new ApiError(500, 'kaput', 'internals'); }),
      logger,
      { production: true },
    );
    await app.request('/x');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('kaput'), expect.any(Error));
  });

  it('passes an HTTPException-carried Response through verbatim (the thrown-Response replacement)', async () => {
    const envelope = new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'nope' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
    const app = appWith(new Hono().get('/rpc', () => {
      throw new HTTPException(401, { res: envelope });
    }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/rpc');
    expect(res.status).toBe(401);
    expect(res.data).toEqual({ jsonrpc: '2.0', error: { code: -32001, message: 'nope' } });
  });

  it('logs a 4xx HTTPException as a warning (the pass-through is otherwise silent)', async () => {
    // Regression: Hono's own json validator raises HTTPException for a
    // malformed body and answers with a bare text/plain response. While the
    // pass-through skipped the logger, such a failure was observable from
    // neither side — absent from the logs, and unreadable by any client that
    // expects the framework's JSON error envelope.
    const warn = vi.fn();
    const logger: Logger = { ...silentLogger, warn };
    const app = registerErrorHandler(
      new Hono().post('/x', () => { throw new HTTPException(400, { message: 'Malformed JSON in request body' }); }),
      logger,
      { production: false },
    );
    await app.request('/x', { method: 'POST' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Malformed JSON in request body'),
      expect.objectContaining({
        'http.request.method': 'POST',
        'url.path': '/x',
        'http.response.status_code': 400,
      }),
    );
  });

  it('logs a 5xx HTTPException at error level, with the error itself', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const app = registerErrorHandler(
      new Hono().get('/x', () => { throw new HTTPException(503, { message: 'upstream down' }); }),
      logger,
      { production: false },
    );
    await app.request('/x');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('upstream down'),
      expect.any(Error),
      expect.any(Object),
    );
  });

  it('does NOT log a sub-4xx HTTPException-carried Response (a deliberate exact answer)', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, warn, error };
    const app = registerErrorHandler(
      new Hono().get('/x', () => {
        throw new HTTPException(200, { res: new Response('ok', { status: 200 }) });
      }),
      logger,
      { production: false },
    );
    await app.request('/x');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('statusErrorWithSet works in a Hono handler via a set shim (route-glue parity)', async () => {
    // The reynt route idiom `if (!result.ok) return statusErrorWithSet(set, result.error)`
    // maps to Hono as a two-liner with a local set object.
    const app = new Hono().get('/svc', (c) => {
      const set: { status?: number | string } = {};
      const body = statusErrorWithSet(set, { key: 'listing_not_found', message: 'no such listing' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return c.json(body, set.status as any);
    });
    const res = await testRequest(testableHonoApp(app), 'GET', '/svc');
    expect(res.status).toBe(404);
    expect(res.data).toEqual({ key: 'listing_not_found', message: 'no such listing' });
  });
});

describe('octValidator (VALIDATION mapping)', () => {
  const schema = z.object({
    name: z.string().min(1),
    price: z.number().min(0),
  });

  function build() {
    const routes = new Hono().post('/items', octValidator('json', schema), (c) => {
      const body = c.req.valid('json');
      return c.json({ created: body.name, price: body.price });
    });
    return registerErrorHandler(routes, silentLogger, { production: false });
  }

  it('passes valid bodies through with typed access', async () => {
    const res = await testRequest(testableHonoApp(build()), 'POST', '/items', {
      body: { name: 'chair', price: 10 },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ created: 'chair', price: 10 });
  });

  it('maps a schema failure to the standard validation_error body with fields', async () => {
    const res = await testRequest(testableHonoApp(build()), 'POST', '/items', {
      body: { name: '', price: -1 },
    });
    expect(res.status).toBe(400);
    const data = res.data as { key: string; message: string; fields: Array<{ path: string; message: string }> };
    expect(data.key).toBe('validation_error');
    expect(data.message).toBe('Validation failed');
    expect(data.fields.map((f) => f.path).sort()).toEqual(['name', 'price']);
  });

  it('joins nested paths with slashes', () => {
    const nested = z.object({ address: z.object({ city: z.string().min(1) }) });
    const parsed = nested.safeParse({ address: { city: '' } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const err = new RequestValidationError(
        parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('/'), message: issue.message })),
      );
      expect(err.all[0]?.path).toBe('address/city');
    }
  });
});

describe('security-headers middleware', () => {
  function build() {
    const app = new Hono();
    app.use(createSecurityHeadersMiddleware({ production: false }));
    registerErrorHandler(app, silentLogger, { production: false });
    app.get('/ok', (c) => c.json({ ok: true }));
    app.get('/boom', () => { throw new ApiError(418, 'teapot', 'short and stout'); });
    return app;
  }

  it('sets hardening headers on success responses', async () => {
    const res = await build().request('/ok');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-XSS-Protection')).toBe('0');
  });

  it('applies headers to error responses and 404s (the onRequest-staging equivalent)', async () => {
    const boom = await build().request('/boom');
    expect(boom.status).toBe(418);
    expect(boom.headers.get('X-Frame-Options')).toBe('DENY');

    const missing = await build().request('/nowhere');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('emits HSTS only under production', async () => {
    const prod = new Hono().use(createSecurityHeadersMiddleware({ production: true })).get('/', (c) => c.text('x'));
    expect((await prod.request('/')).headers.get('Strict-Transport-Security')).toContain('max-age=');

    const dev = new Hono().use(createSecurityHeadersMiddleware({ production: false })).get('/', (c) => c.text('x'));
    expect((await dev.request('/')).headers.get('Strict-Transport-Security')).toBeNull();
  });
});

describe('createHealthApp', () => {
  it('serves liveness 200 on the alias and /live', async () => {
    const app = new Hono().route('/health', createHealthApp({ checkReady: async () => {} }));
    const harness = testableHonoApp(app);
    expect((await testRequest(harness, 'GET', '/health')).data).toEqual({ status: 'ok' });
    expect((await testRequest(harness, 'GET', '/health/live')).data).toEqual({ status: 'ok' });
  });

  it('serves readiness 200 when checkReady resolves', async () => {
    const app = new Hono().route('/health', createHealthApp({ checkReady: async () => {} }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok', db: 'connected' });
  });

  it('maps a /ready failure to 503 with the standard error body', async () => {
    const app = new Hono().route('/health', createHealthApp({
      checkReady: async () => { throw new Error('no db'); },
    }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/health/ready');
    expect(res.status).toBe(503);
    expect(res.data).toEqual({ status: 'error', message: 'Database unavailable' });
  });

  it('honors a custom mount path and readyErrorMessage, and logs the failure', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const app = new Hono().route('/status', createHealthApp({
      checkReady: async () => { throw new Error('nope'); },
      logger,
      readyErrorMessage: 'DB down',
    }));
    const res = await testRequest(testableHonoApp(app), 'GET', '/status/ready');
    expect(res.status).toBe(503);
    expect(res.data).toEqual({ status: 'error', message: 'DB down' });
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('createHonoApp', () => {
  const routes = new Hono()
    .get('/api/ok', (c) => c.json({ ok: true }))
    .get('/api/boom', () => { throw new NotFoundError('missing', 'thing_not_found'); });

  it('mounts hardening + routes + error handler in order', async () => {
    const app = createHonoApp(routes, { logger: silentLogger, securityHeaders: { production: false } });
    const ok = await testRequest(testableHonoApp(app), 'GET', '/api/ok');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Frame-Options')).toBe('DENY'); // security headers applied
    const boom = await testRequest(testableHonoApp(app), 'GET', '/api/boom');
    expect(boom.status).toBe(404); // error handler wired
    expect((boom.data as { key: string }).key).toBe('thing_not_found');
    expect(boom.headers.get('X-Frame-Options')).toBe('DENY'); // …on error paths too
  });

  it('skips security headers when disabled', async () => {
    const app = createHonoApp(routes, { logger: silentLogger, securityHeaders: false });
    const res = await app.request('/api/ok');
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('mounts caller middleware between security headers and the error handler', async () => {
    const app = createHonoApp(routes, {
      logger: silentLogger,
      securityHeaders: false,
      middleware: [async (c, next) => { await next(); c.res.headers.set('x-marker', 'yes'); }],
    });
    const res = await app.request('/api/ok');
    expect(res.headers.get('x-marker')).toBe('yes');
  });
});

describe('SSE stream handler via app.mount()', () => {
  const subscriber = { scopeKey: 'scope-a', subscriberId: 'u1' };

  function durable(seq: number): EventEnvelope {
    return {
      id: `evt-${seq}`,
      seq,
      type: 'order.created',
      scopeKey: 'scope-a',
      at: '2026-07-29T00:00:00.000Z',
      lane: 'durable',
      data: {},
    };
  }

  it('round-trips the framework-agnostic fetch handler: headers + a live frame', async () => {
    const hub = createEventHub();
    const { handler } = createEventStreamHandler({ hub, resolveSubscriber: () => subscriber });

    const routes = new Hono().get('/api/ok', (c) => c.json({ ok: true }));
    const app = createHonoApp(routes, { logger: silentLogger, securityHeaders: false });
    app.mount('/api/events', handler);

    const controller = new AbortController();
    const response = await app.request('http://localhost/api/events', { signal: controller.signal });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // The load-bearing anti-buffering header must survive the mount.
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    hub.publish(durable(41));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 2_000;
    while (!buffer.includes('id: 41')) {
      if (Date.now() > deadline) throw new Error(`timeout; buffer so far:\n${buffer}`);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer).toContain('event: order.created');
    controller.abort();
  });

  it('propagates auth rejection (401) from the handler through the mount', async () => {
    const hub = createEventHub();
    const { handler } = createEventStreamHandler({ hub, resolveSubscriber: () => null });
    const app = new Hono();
    app.mount('/events', handler);
    const res = await app.request('/events');
    expect(res.status).toBe(401);
  });
});
