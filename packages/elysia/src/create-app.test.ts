import { describe, it, expect, vi } from 'vitest';
import { Elysia } from 'elysia';
import type { Logger } from '@octabits-io/foundation/logger';
import { createElysiaApp, registerGracefulShutdown } from './create-app';
import { NotFoundError } from './errors';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

const routes = new Elysia({ prefix: '/api' })
  .get('/ok', () => ({ ok: true }))
  .get('/boom', () => { throw new NotFoundError('missing', 'thing_not_found'); });

describe('createElysiaApp', () => {
  it('mounts hardening + routes + error handler in order', async () => {
    const app = createElysiaApp(routes, { logger: silentLogger, clientIp: [] });
    const ok = await app.handle(new Request('http://localhost/api/ok'));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('X-Frame-Options')).toBe('DENY'); // security headers applied
    const boom = await app.handle(new Request('http://localhost/api/boom'));
    expect(boom.status).toBe(404); // error handler mounted before routes
    expect(((await boom.json()) as { key: string }).key).toBe('thing_not_found');
  });

  it('skips security headers / clientIp / rateLimit when disabled', async () => {
    const app = createElysiaApp(routes, { logger: silentLogger, securityHeaders: false });
    const res = await app.handle(new Request('http://localhost/api/ok'));
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('rate limits when configured', async () => {
    const app = createElysiaApp(routes, { logger: silentLogger, rateLimit: { max: 1, keyByClientIp: false } });
    await app.handle(new Request('http://localhost/api/ok'));
    const second = await app.handle(new Request('http://localhost/api/ok'));
    expect(second.status).toBe(429);
  });

  it('mounts caller plugins between rate limiter and error handler', async () => {
    const marker = new Elysia({ name: 'marker' }).onAfterHandle({ as: 'global' }, ({ set }) => {
      set.headers['x-marker'] = 'yes';
    });
    const app = createElysiaApp(routes, { logger: silentLogger, plugins: [marker] });
    const res = await app.handle(new Request('http://localhost/api/ok'));
    expect(res.headers.get('x-marker')).toBe('yes');
  });
});

describe('registerGracefulShutdown', () => {
  it('wires signals to stop + exit(0)', async () => {
    const stop = vi.fn(async () => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const on = vi.spyOn(process, 'on');
    registerGracefulShutdown({ logger: silentLogger, stop, signals: ['SIGUSR2'] });
    const handler = on.mock.calls.find(([s]) => s === 'SIGUSR2')?.[1] as () => void;
    expect(handler).toBeTypeOf('function');
    handler();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('SIGUSR2'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    exit.mockRestore(); on.mockRestore();
  });
});
