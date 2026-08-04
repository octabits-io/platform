/**
 * Route-module factory: the middleware-mounting guarantee and the param-ful
 * mount path. (createHonoApp's pipeline is covered in hono.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import type { Logger } from '../logger/index.ts';
import { buildSwaggerOptions } from '../server/swagger';
import { createHonoApp, createRouteModule } from './create-app';
import { createHealthApp } from './health';
import { mountOpenApi } from './openapi';
import { createRequestScopeMiddleware, type RequestScopeEnv } from './request-scope';

interface TestScope {
  value: string;
  dispose(): Promise<void>;
}

function testScope(value: string): TestScope {
  return { value, dispose: () => Promise.resolve() };
}

describe('createRouteModule', () => {
  it('mounts the middleware before every route in the module', async () => {
    const routes = createRouteModule<RequestScopeEnv<TestScope>, Hono<RequestScopeEnv<TestScope>>>(
      { middleware: [createRequestScopeMiddleware({ createScope: () => testScope('seeded') })] },
      (app) => app.get('/value', (c) => c.json({ value: c.get('scope').value })),
    );

    const res = await new Hono().route('/module', routes).fetch(new Request('http://localhost/module/value'));
    expect(await res.json()).toEqual({ value: 'seeded' });
  });

  it('exposes route params to the middleware under a param-carrying mount path', async () => {
    const routes = createRouteModule<RequestScopeEnv<TestScope>, Hono<RequestScopeEnv<TestScope>>>(
      {
        path: '/:tenantId/*',
        middleware: [
          createRequestScopeMiddleware({
            createScope: ({ params }) => testScope(params.tenantId ?? 'missing'),
          }),
        ],
      },
      (app) => app.get('/:tenantId/value', (c) => c.json({ value: c.get('scope').value })),
    );

    const res = await new Hono().route('/', routes).fetch(new Request('http://localhost/acme/value'));
    expect(await res.json()).toEqual({ value: 'acme' });
  });
});

describe('createHonoApp hono constructor options', () => {
  const silentLogger: Logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    child: () => silentLogger,
  };

  it('strict: false makes /x and /x/ the same route (Elysia parity for migrating consumers)', async () => {
    const routes = new Hono().route('/nested', new Hono().get('/', (c) => c.json({ ok: true })));

    const strict = createHonoApp(routes, { logger: silentLogger });
    const loose = createHonoApp(routes, { logger: silentLogger, hono: { strict: false } });

    // Default stays Hono's: the trailing-slash variant is a different route.
    expect((await strict.request('/nested')).status).toBe(200);
    expect((await strict.request('/nested/')).status).toBe(404);
    // Path normalization happens on the SERVING app, so the option must be
    // honored by the outer Hono createHonoApp constructs — not the routes app.
    expect((await loose.request('/nested')).status).toBe(200);
    expect((await loose.request('/nested/')).status).toBe(200);
  });
});

/**
 * The `hc` type-preservation gate. `createHonoApp` must NOT annotate its return
 * as `Hono` — that is `BlankSchema`, and it erases every route from the client
 * type while the app keeps serving correctly. The failure is invisible at
 * runtime and only shows up as an empty `hc<App>` in a consumer, so it is
 * pinned here as a compile-time assertion.
 */
describe('createHonoApp route-type preservation (hc gate)', () => {
  const silentLogger: Logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    child: () => silentLogger,
  };

  it('keeps the routes reachable through hc<typeof app>', async () => {
    const routes = new Hono()
      .get('/ping', (c) => c.json({ pong: true }))
      .post('/echo', (c) => c.json({ echoed: true }, 201));
    const app = createHonoApp(routes, { logger: silentLogger });

    // `hc` calls its `fetch` with a URL string, which `app.fetch` (Request-only)
    // rejects — `app.request` accepts both.
    const client = hc<typeof app>('http://localhost', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input as string, init),
    });
    // Compile-time: these properties exist ONLY if the schema survived.
    const pong = await (await client.ping.$get()).json();
    const echoed = await (await client.echo.$post()).json();

    expect(pong).toEqual({ pong: true });
    expect(echoed).toEqual({ echoed: true });
  });

  it('keeps the sub-app factories reachable too (health, mountOpenApi chain)', async () => {
    const routes = new Hono().route('/health', createHealthApp({ checkReady: () => Promise.resolve() }));
    const app = mountOpenApi(createHonoApp(routes, { logger: silentLogger }), {
      ...buildSwaggerOptions({ title: 'Gate', version: '1.0.0' }),
    });

    const client = hc<typeof app>('http://localhost', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input as string, init),
    });
    // `createHealthApp` returning a bare `Hono` (BlankSchema) would drop all
    // three probes; `mountOpenApi` returning its own `app.get(specPath, …)`
    // type would collapse the whole schema behind a non-literal path key.
    const ready = await client.health.ready.$get();
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', db: 'connected' });
    // The spec route is deliberately NOT in the client type — browsed, not called.
    expect((await app.request('/openapi.json')).status).toBe(200);
  });
});
