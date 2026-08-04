/**
 * Rate-limit middleware over the in-house fixed-window core: limit + 429
 * contract, per-key isolation via the client-IP variable, and each skip rule
 * (paths, internal secret, CIDR), plus the missing-clientIp warning.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Logger } from '../logger/index.ts';
import { createClientIpMiddleware, type ClientIpEnv } from './client-ip';
import { createRateLimitMiddleware, type RateLimitMiddlewareOptions } from './rate-limit';

/** App that derives clientIp from an `x-test-ip` header (as the direct peer). */
function limitedApp(options: RateLimitMiddlewareOptions) {
  const app = new Hono<ClientIpEnv>();
  app.use(createClientIpMiddleware({ getDirectIp: (c) => c.req.raw.headers.get('x-test-ip') ?? undefined }));
  app.use(createRateLimitMiddleware(options));
  app.get('/', (c) => c.json({ ok: true }));
  app.get('/stream/sub', (c) => c.json({ ok: true }));
  return app;
}

function get(app: Hono<ClientIpEnv>, headers: Record<string, string> = {}, path = '/') {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe('createRateLimitMiddleware', () => {
  it('allows max requests per window, then answers 429 with the standard body and Retry-After', async () => {
    const app = limitedApp({ max: 2 });
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(200);
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(200);

    const limited = await get(app, { 'x-test-ip': '203.0.113.1' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toEqual({
      key: 'rate_limit_exceeded',
      message: 'Too many requests, please try again later',
    });
  });

  it('counts per client IP — one exhausted key does not limit another', async () => {
    const app = limitedApp({ max: 1 });
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(200);
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(429);
    expect((await get(app, { 'x-test-ip': '203.0.113.2' })).status).toBe(200);
  });

  it('honours custom errorKey/errorMessage', async () => {
    const app = limitedApp({ max: 0, errorKey: 'slow_down', errorMessage: 'Easy there' });
    const limited = await get(app, { 'x-test-ip': '203.0.113.1' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ key: 'slow_down', message: 'Easy there' });
  });

  it('skips exempted path prefixes entirely', async () => {
    const app = limitedApp({ max: 0, skipPaths: ['/stream'] });
    expect((await get(app, { 'x-test-ip': '203.0.113.1' }, '/stream/sub')).status).toBe(200);
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(429);
  });

  it('bypasses for the internal secret header (and only the exact secret)', async () => {
    const app = limitedApp({ max: 0, internalSecret: 's3cret' });
    expect((await get(app, { 'x-test-ip': '203.0.113.1', 'x-api-secret': 's3cret' })).status).toBe(200);
    expect((await get(app, { 'x-test-ip': '203.0.113.1', 'x-api-secret': 'wrong' })).status).toBe(429);
  });

  it('bypasses client IPs inside skipCidrs', async () => {
    const app = limitedApp({ max: 0, skipCidrs: ['10.0.0.0/8'] });
    expect((await get(app, { 'x-test-ip': '10.1.2.3' })).status).toBe(200);
    expect((await get(app, { 'x-test-ip': '203.0.113.1' })).status).toBe(429);
  });

  it("shares one 'unknown' bucket and warns once when clientIp is missing", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const app = new Hono();
    app.use(createRateLimitMiddleware({ max: 1, logger }));
    app.get('/', (c) => c.json({ ok: true }));

    expect((await get(app as never, { 'x-test-ip': '203.0.113.1' })).status).toBe(200);
    // Different "client", same bucket: limited — and the warning fired exactly once.
    expect((await get(app as never, { 'x-test-ip': '203.0.113.2' })).status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('supports a custom key function instead of the client IP', async () => {
    const app = limitedApp({ max: 1, keyByClientIp: (c) => c.req.raw.headers.get('x-user') ?? 'anon' });
    expect((await get(app, { 'x-user': 'a' })).status).toBe(200);
    expect((await get(app, { 'x-user': 'a' })).status).toBe(429);
    expect((await get(app, { 'x-user': 'b' })).status).toBe(200);
  });
});
