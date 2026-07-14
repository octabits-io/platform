import { describe, it, expect, vi } from 'vitest';
import { createHealthRoutes } from './health';

describe('createHealthRoutes', () => {
  it('serves liveness 200 on the alias and /live', async () => {
    const app = createHealthRoutes({ checkReady: async () => {} });

    const alias = await app.handle(new Request('http://localhost/health'));
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual({ status: 'ok' });

    const live = await app.handle(new Request('http://localhost/health/live'));
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
  });

  it('serves readiness 200 when checkReady resolves', async () => {
    const checkReady = vi.fn(async () => {});
    const app = createHealthRoutes({ checkReady });

    const res = await app.handle(new Request('http://localhost/health/ready'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'connected' });
    expect(checkReady).toHaveBeenCalledTimes(1);
  });

  it('maps a /ready failure to 503 with the standard error body', async () => {
    const app = createHealthRoutes({
      checkReady: async () => {
        throw new Error('connection refused');
      },
    });

    const res = await app.handle(new Request('http://localhost/health/ready'));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ status: 'error', message: 'Database unavailable' });
  });

  it('honors a custom prefix and readyErrorMessage, and logs the failure', async () => {
    const errorSpy = vi.fn();
    const logger = { error: errorSpy } as unknown as NonNullable<
      Parameters<typeof createHealthRoutes>[0]['logger']
    >;
    const app = createHealthRoutes({
      prefix: '/api/health',
      readyErrorMessage: 'DB down',
      logger,
      checkReady: async () => {
        throw new Error('boom');
      },
    });

    const res = await app.handle(new Request('http://localhost/api/health/ready'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', message: 'DB down' });
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
