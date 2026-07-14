import { describe, it, expect, vi } from 'vitest';
import { Elysia } from 'elysia';
import { IoC, ServiceLifetime } from '../ioc/index.ts';
import type { Logger } from '../logger/index.ts';
import { createRequestScopePlugin } from './request-scope';
import { createElysiaApp } from './create-app';
import { ForbiddenError } from './errors';

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

function buildHarness() {
  const root = new IoC<Services>();
  root.register('greeting', () => 'hello');

  const disposals: Array<{ commit: boolean }> = [];

  const plugin = createRequestScopePlugin({
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

  return { root, plugin, disposals };
}

describe('createRequestScopePlugin', () => {
  it('exposes the scope in ctx and resolves scoped + parent services', async () => {
    const { plugin } = buildHarness();
    const app = new Elysia()
      .use(plugin)
      .get('/whoami', ({ scope }) => ({
        role: scope.resolve('role'),
        greeting: scope.resolve('greeting'), // falls through to the root container
      }));

    const res = await app.handle(
      new Request('http://localhost/whoami', { headers: { 'x-role': 'admin' } }),
    );
    expect(await res.json()).toEqual({ role: 'admin', greeting: 'hello' });
  });

  it('creates an isolated scope per request', async () => {
    const seen: string[] = [];
    const { plugin } = buildHarness();
    const app = new Elysia().use(plugin).get('/role', ({ scope }) => {
      const role = scope.resolve('role');
      seen.push(role);
      return role;
    });

    await app.handle(new Request('http://localhost/role', { headers: { 'x-role': 'admin' } }));
    await app.handle(new Request('http://localhost/role'));
    expect(seen).toEqual(['admin', 'viewer']);
  });

  it('disposes with commit: true after a successful response', async () => {
    const { plugin, disposals } = buildHarness();
    const app = new Elysia().use(plugin).get('/ok', ({ scope }) => scope.resolve('role'));

    await app.handle(new Request('http://localhost/ok'));
    // onAfterResponse fires detached, after the response promise resolves.
    await vi.waitFor(() => { expect(disposals).toEqual([{ commit: true }]); });
  });

  it('disposes with commit: false when the handler throws — exactly once despite onAfterResponse also firing', async () => {
    const { plugin, disposals } = buildHarness();
    const app = new Elysia().use(plugin).get('/boom', ({ scope }) => {
      scope.resolve('role');
      throw new Error('handler exploded');
    });

    const res = await app.handle(new Request('http://localhost/boom'));
    expect(res.status).toBe(500);
    expect(disposals).toEqual([{ commit: false }]);
    // Let the detached onAfterResponse fire too: its dispose must be a no-op
    // because the IoC scope drained its disposables in the onError dispose.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('disposes with commit: false and rethrows when guard rejects', async () => {
    const root = new IoC<Services>();
    root.register('greeting', () => 'hello');
    const disposals: Array<{ commit: boolean }> = [];
    const handler = vi.fn();

    const plugin = createRequestScopePlugin({
      createScope: () => {
        const scope = root.createScope();
        scope.onDispose((opts) => { disposals.push({ commit: opts.commit }); });
        return scope;
      },
      guard: () => {
        throw new ForbiddenError('nope', 'forbidden');
      },
    });

    const app = createElysiaApp(
      new Elysia().use(plugin).get('/guarded', (ctx) => { handler(); return ctx.scope.resolve('greeting'); }),
      { logger: silentLogger, securityHeaders: false },
    );

    const res = await app.handle(new Request('http://localhost/guarded'));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(disposals).toEqual([{ commit: false }]);
  });

  it('propagates createScope errors without a scope to leak', async () => {
    const plugin = createRequestScopePlugin({
      createScope: () => {
        throw new ForbiddenError('no scope for you', 'forbidden');
      },
    });
    const app = createElysiaApp(
      new Elysia().use(plugin).get('/never', ({ scope }) => scope),
      { logger: silentLogger, securityHeaders: false },
    );

    const res = await app.handle(new Request('http://localhost/never'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { key: string }).key).toBe('forbidden');
  });

  it('logs instead of throwing when dispose fails after the response', async () => {
    const error = vi.fn();
    const logger: Logger = { ...silentLogger, error };
    const plugin = createRequestScopePlugin({
      logger,
      createScope: () => ({
        dispose: async () => { throw new Error('release failed'); },
      }),
    });
    const app = new Elysia().use(plugin).get('/ok', () => 'ok');

    const res = await app.handle(new Request('http://localhost/ok'));
    expect(res.status).toBe(200);
    // onAfterResponse fires detached, after the response promise resolves.
    await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce(); });
  });

  it('passes request context (path, params) to createScope', async () => {
    const paths: string[] = [];
    const plugin = createRequestScopePlugin({
      createScope: (ctx) => {
        paths.push(ctx.path);
        return { dispose: async () => {} };
      },
    });
    const app = new Elysia().use(plugin).get('/ctx/:id', ({ params }) => params.id);

    const res = await app.handle(new Request('http://localhost/ctx/42'));
    expect(await res.text()).toBe('42');
    expect(paths).toEqual(['/ctx/42']);
  });
});
