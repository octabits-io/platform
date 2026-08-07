/**
 * The disposal-triangle acid test: success / handler-throw / guard-rejection /
 * createScope-throw / dispose-failure logging / contextKey / extras, against
 * the single-middleware implementation, plus the Hono-specific cases at the
 * bottom (non-Error throw, params visibility). Ported case-for-case from the
 * Elysia plugin's suite, so the contract is provably unchanged across the swap.
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { IoC, ServiceLifetime } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';
import { createRequestScopeMiddleware, type RequestScopeEnv } from './request-scope';
import { createHonoApp } from './create-app';
import { ForbiddenError } from '../server/errors';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

interface Services {
  greeting: string;
}

interface RequestServices {
  role: string;
}

type Scope = IoC<Services>;

function buildHarness() {
  const root = new IoC<Services>();
  root.register('greeting', () => 'hello');

  const disposals: Array<{ commit: boolean }> = [];

  const middleware = createRequestScopeMiddleware({
    createScope: ({ request }) => {
      const scope = root.createScope<RequestServices>();
      scope.register(
        'role',
        () => request.headers.get('x-role') ?? 'viewer',
        ServiceLifetime.Scoped,
      );
      scope.onDispose((opts) => { disposals.push({ commit: opts.commit }); });
      return scope;
    },
  });

  return { root, middleware, disposals };
}

type HarnessEnv = RequestScopeEnv<IoC<RequestServices & Services>>;

describe('createRequestScopeMiddleware', () => {
  it('exposes the scope in ctx and resolves scoped + parent services', async () => {
    const { middleware } = buildHarness();
    const app = new Hono<HarnessEnv>()
      .use(middleware)
      .get('/whoami', (c) => c.json({
        role: c.get('scope').resolve('role'),
        greeting: c.get('scope').resolve('greeting'), // falls through to the root container
      }));

    const res = await app.request('/whoami', { headers: { 'x-role': 'admin' } });
    expect(await res.json()).toEqual({ role: 'admin', greeting: 'hello' });
  });

  it('creates an isolated scope per request', async () => {
    const seen: string[] = [];
    const { middleware } = buildHarness();
    const app = new Hono<HarnessEnv>().use(middleware).get('/role', (c) => {
      const role = c.get('scope').resolve('role');
      seen.push(role);
      return c.text(role);
    });

    await app.request('/role', { headers: { 'x-role': 'admin' } });
    await app.request('/role');
    expect(seen).toEqual(['admin', 'viewer']);
  });

  it('disposes with commit: true after a successful response', async () => {
    const { middleware, disposals } = buildHarness();
    const app = new Hono<HarnessEnv>().use(middleware).get('/ok', (c) => c.text(c.get('scope').resolve('role')));

    await app.request('/ok');
    // Unlike Elysia's detached onAfterResponse, the middleware unwinds before
    // fetch resolves — no waitFor needed.
    expect(disposals).toEqual([{ commit: true }]);
  });

  it('disposes with commit: false when the handler throws — exactly once', async () => {
    const { middleware, disposals } = buildHarness();
    const app = new Hono<HarnessEnv>().use(middleware).get('/boom', (c) => {
      c.get('scope').resolve('role');
      throw new Error('handler exploded');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    // Single dispose site — there is no second hook that could double-fire.
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('disposes with commit: false and rethrows when guard rejects', async () => {
    const root = new IoC<Services>();
    root.register('greeting', () => 'hello');
    const disposals: Array<{ commit: boolean }> = [];
    const handler = vi.fn();

    const middleware = createRequestScopeMiddleware({
      createScope: () => {
        const scope = root.createScope();
        scope.onDispose((opts) => { disposals.push({ commit: opts.commit }); });
        return scope;
      },
      guard: () => {
        throw new ForbiddenError('nope', 'forbidden');
      },
    });

    const routes = new Hono<RequestScopeEnv<Scope>>()
      .use(middleware)
      .get('/guarded', (c) => { handler(); return c.text(c.get('scope').resolve('greeting')); });
    const app = createHonoApp(routes, { logger: silentLogger, securityHeaders: false });

    const res = await app.request('/guarded');
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('propagates createScope errors without a scope to leak', async () => {
    const middleware = createRequestScopeMiddleware({
      createScope: () => {
        throw new ForbiddenError('no scope for you', 'forbidden');
      },
    });
    const routes = new Hono().use(middleware).get('/never', (c) => c.text('unreachable'));
    const app = createHonoApp(routes, { logger: silentLogger, securityHeaders: false });

    const res = await app.request('/never');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { key: string }).key).toBe('forbidden');
  });

  it('logs instead of throwing when dispose fails after the response', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const middleware = createRequestScopeMiddleware({
      logger,
      createScope: () => ({
        dispose: async () => { throw new Error('release failed'); },
      }),
    });
    const app = new Hono().use(middleware).get('/ok', (c) => c.text('ok'));

    const res = await app.request('/ok');
    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalledOnce();
  });

  it('passes request context (path, params) to createScope when mounted on a param path', async () => {
    const paths: string[] = [];
    const params: Array<Record<string, string | undefined>> = [];
    const middleware = createRequestScopeMiddleware({
      createScope: (ctx) => {
        paths.push(ctx.path);
        params.push(ctx.params);
        return { dispose: async () => {} };
      },
    });
    // Mounted param-fully — the Hono equivalent of the Elysia plugin seeing
    // route params (a bare `.use(middleware)` matches `*` and sees `{}`).
    const app = new Hono().use('/ctx/:id', middleware).get('/ctx/:id', (c) => c.text(c.req.param('id')));

    const res = await app.request('/ctx/42');
    expect(await res.text()).toBe('42');
    expect(paths).toEqual(['/ctx/42']);
    expect(params).toEqual([{ id: '42' }]);
  });
});

describe('contextKey + extras', () => {
  it('exposes the scope under a custom context key', async () => {
    const root = new IoC<Services>();
    root.register('greeting', () => 'hi');
    const middleware = createRequestScopeMiddleware({
      contextKey: 'container',
      createScope: () => root.createScope(),
    });
    const app = new Hono<RequestScopeEnv<Scope, Record<never, never>, 'container'>>()
      .use(middleware)
      .get('/greet', (c) => c.text(c.get('container').resolve('greeting')));

    const res = await app.request('/greet');
    expect(await res.text()).toBe('hi');
  });

  it('merges extras returned from createScope into the context', async () => {
    const root = new IoC<Services>();
    root.register('greeting', () => 'hello');
    const disposals: Array<{ commit: boolean }> = [];
    const middleware = createRequestScopeMiddleware({
      createScope: ({ params }) => {
        const scope = root.createScope();
        scope.onDispose((opts) => { disposals.push({ commit: opts.commit }); });
        return { scope, extras: { resourceId: params.id ?? 'none' } };
      },
    });
    const app = new Hono<RequestScopeEnv<Scope, { resourceId: string }>>()
      .use('/things/:id', middleware)
      .get('/things/:id', (c) => c.json({
        id: c.get('resourceId'),
        greeting: c.get('scope').resolve('greeting'),
      }));

    const res = await app.request('/things/42');
    expect(await res.json()).toEqual({ id: '42', greeting: 'hello' });
    expect(disposals).toEqual([{ commit: true }]);
  });

  it('disposes under a custom key on the error path too', async () => {
    const disposals: Array<{ commit: boolean }> = [];
    const middleware = createRequestScopeMiddleware({
      contextKey: 'container',
      createScope: () => ({
        dispose: async (opts = { commit: true }) => { disposals.push({ commit: opts.commit }); },
      }),
    });
    const app = new Hono().use(middleware).get('/boom', () => {
      throw new Error('nope');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(disposals).toEqual([{ commit: false }]);
  });
});

describe('Hono-specific edges', () => {
  it('disposes with commit: false when a non-Error is thrown (rethrown past onError)', async () => {
    const disposals: Array<{ commit: boolean }> = [];
    const middleware = createRequestScopeMiddleware({
      createScope: () => ({
        dispose: async (opts = { commit: true }) => { disposals.push({ commit: opts.commit }); },
      }),
    });
    const app = new Hono().use(middleware).get('/weird', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'not an error';
    });

    // Hono rethrows non-Error values past onError; whether fetch rejects or
    // resolves is not this contract's concern — the disposal is.
    await Promise.resolve(app.request('/weird')).catch(() => undefined);
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('a bare use() sees empty params — the documented mount-pattern caveat', async () => {
    const params: Array<Record<string, string | undefined>> = [];
    const middleware = createRequestScopeMiddleware({
      createScope: (ctx) => {
        params.push(ctx.params);
        return { dispose: async () => {} };
      },
    });
    const app = new Hono().use(middleware).get('/ctx/:id', (c) => c.text(c.req.param('id')));

    await app.request('/ctx/42');
    expect(params).toEqual([{}]);
  });
});

describe('overlapping-mount dedupe', () => {
  it('allocates ONE scope when overlapping route mounts each carry the middleware', async () => {
    // The real-world shape: two modules mounted at the same prefix, both
    // wrapping themselves in the shared scope middleware via use('*').
    // Hono copies both `use` entries into the parent as `/things/*`
    // middleware, so a request to either module's route matches both.
    let created = 0;
    const disposals: Array<{ commit: boolean }> = [];
    const root = new IoC<Services>();
    root.register('greeting', () => 'hello');
    const middleware = createRequestScopeMiddleware({
      createScope: () => {
        created += 1;
        const scope = root.createScope<RequestServices>();
        scope.register('role', () => 'viewer', ServiceLifetime.Scoped);
        scope.onDispose((opts) => { disposals.push({ commit: opts.commit }); });
        return scope;
      },
    });

    const moduleA = new Hono<HarnessEnv>()
      .use(middleware)
      .get('/a', (c) => c.text(c.get('scope').resolve('role')));
    const moduleB = new Hono<HarnessEnv>()
      .use(middleware)
      .get('/b', (c) => c.text(c.get('scope').resolve('greeting')));

    const app = new Hono<HarnessEnv>()
      .route('/things', moduleA)
      .route('/things', moduleB);

    const res = await app.request('/things/b');
    expect(await res.text()).toBe('hello');
    expect(created).toBe(1);
    expect(disposals).toEqual([{ commit: true }]);
  });

  it('still disposes exactly once when the handler under a deduped mount throws', async () => {
    const disposals: Array<{ commit: boolean }> = [];
    const middleware = createRequestScopeMiddleware({
      createScope: () => ({
        dispose: async (opts = { commit: true }) => { disposals.push({ commit: opts.commit }); },
      }),
    });

    const moduleA = new Hono().use(middleware).get('/a', (c) => c.text('ok'));
    const moduleB = new Hono().use(middleware).get('/b', () => {
      throw new ForbiddenError('nope');
    });
    const app = createHonoApp(
      new Hono().route('/things', moduleA).route('/things', moduleB),
      { logger: silentLogger },
    );

    const res = await app.request('/things/b');
    expect(res.status).toBe(403);
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('does NOT dedupe middlewares with distinct context keys', async () => {
    let outerCreated = 0;
    let innerCreated = 0;
    const outer = createRequestScopeMiddleware({
      contextKey: 'outer',
      createScope: () => {
        outerCreated += 1;
        return { dispose: async () => {} };
      },
    });
    const inner = createRequestScopeMiddleware({
      contextKey: 'inner',
      createScope: () => {
        innerCreated += 1;
        return { dispose: async () => {} };
      },
    });

    const app = new Hono().use(outer).use(inner).get('/both', (c) => c.text('ok'));

    await app.request('/both');
    expect(outerCreated).toBe(1);
    expect(innerCreated).toBe(1);
  });
});
