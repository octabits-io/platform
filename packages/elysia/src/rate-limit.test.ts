import { describe, it, expect, vi } from 'vitest';
import { Elysia } from 'elysia';
import type { Logger } from '@octabits-io/foundation/logger';
import { createRateLimit, createCidrMatcher } from './rate-limit';
import { createClientIpPlugin } from './client-ip';

describe('createRateLimit', () => {
  it('lets requests under the limit through', async () => {
    const app = new Elysia().use(createRateLimit({ max: 2 })).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('returns a 429 with the standard body once the limit is exceeded', async () => {
    const app = new Elysia().use(createRateLimit({ max: 1 })).get('/', () => 'ok');
    const first = await app.handle(new Request('http://localhost/'));
    expect(first.status).toBe(200);
    const second = await app.handle(new Request('http://localhost/'));
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      key: 'rate_limit_exceeded',
      message: 'Too many requests, please try again later',
    });
  });

  it('honors custom error key/message on the 429 body', async () => {
    const app = new Elysia()
      .use(createRateLimit({ max: 1, errorKey: 'too_fast', errorMessage: 'slow down' }))
      .get('/', () => 'ok');
    await app.handle(new Request('http://localhost/'));
    const blocked = await app.handle(new Request('http://localhost/'));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ key: 'too_fast', message: 'slow down' });
  });

  it('skips rate limiting when the internal-secret header matches', async () => {
    const app = new Elysia()
      .use(createRateLimit({ max: 1, internalSecret: 'sekret' }))
      .get('/', () => 'ok');
    const headers = { 'x-api-secret': 'sekret' };
    const first = await app.handle(new Request('http://localhost/', { headers }));
    const second = await app.handle(new Request('http://localhost/', { headers }));
    // Both pass despite max: 1 because the internal secret bypasses the limiter.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('respects a custom internal-secret header name', async () => {
    const app = new Elysia()
      .use(createRateLimit({ max: 1, internalSecret: 'sekret', internalSecretHeader: 'x-internal' }))
      .get('/', () => 'ok');
    const first = await app.handle(new Request('http://localhost/', { headers: { 'x-internal': 'sekret' } }));
    const second = await app.handle(new Request('http://localhost/', { headers: { 'x-internal': 'sekret' } }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('skips rate limiting for client IPs inside a trusted CIDR range', async () => {
    const app = new Elysia()
      // trustAll so the forwarded IP is honored and surfaces as derived.clientIp
      .use(createClientIpPlugin(['*']))
      .use(createRateLimit({ max: 1, skipCidrs: ['10.0.0.0/24'] }))
      .get('/', () => 'ok');
    const headers = { 'x-forwarded-for': '10.0.0.5' };
    const first = await app.handle(new Request('http://localhost/', { headers }));
    const second = await app.handle(new Request('http://localhost/', { headers }));
    // Client IP 10.0.0.5 falls inside 10.0.0.0/24 → limiter bypassed.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('scoping: scoped limits only the route group it is mounted in', async () => {
    const guarded = new Elysia({ prefix: '/guarded' })
      .use(createRateLimit({ max: 1, scoping: 'scoped', errorKey: 'guarded_limited' }))
      .get('/', () => 'guarded');
    const app = new Elysia().use(guarded).get('/open', () => 'open');

    const first = await app.handle(new Request('http://localhost/guarded/'));
    expect(first.status).toBe(200);
    const second = await app.handle(new Request('http://localhost/guarded/'));
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ key: 'guarded_limited' });

    // The sibling route outside the group is not limited.
    const open1 = await app.handle(new Request('http://localhost/open'));
    const open2 = await app.handle(new Request('http://localhost/open'));
    expect(open1.status).toBe(200);
    expect(open2.status).toBe(200);
  });

  it('still limits client IPs outside the trusted CIDR ranges', async () => {
    const app = new Elysia()
      .use(createClientIpPlugin(['*']))
      .use(createRateLimit({ max: 1, skipCidrs: ['10.0.0.0/24'] }))
      .get('/', () => 'ok');
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    const first = await app.handle(new Request('http://localhost/', { headers }));
    const second = await app.handle(new Request('http://localhost/', { headers }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('keys two distinct client IPs into separate buckets', async () => {
    const app = new Elysia()
      .use(createClientIpPlugin(['*']))
      .use(createRateLimit({ max: 1 }))
      .get('/', () => 'ok');
    const first = await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '198.51.100.1' } }));
    const blocked = await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '198.51.100.1' } }));
    const other = await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '198.51.100.2' } }));
    expect(first.status).toBe(200);
    expect(blocked.status).toBe(429); // same IP: bucket exhausted
    expect(other.status).toBe(200);   // different IP: its own bucket
  });

  it('warns once when keyByClientIp is set but clientIp is missing', async () => {
    const warn = vi.fn();
    const logger: Logger = { debug: () => {}, info: () => {}, warn, error: () => {}, child: () => logger };
    // No client-ip plugin mounted → derived.clientIp is undefined.
    const app = new Elysia().use(createRateLimit({ max: 10, logger })).get('/', () => 'ok');
    await app.handle(new Request('http://localhost/'));
    await app.handle(new Request('http://localhost/'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('clientIp');
  });
});

describe('createCidrMatcher', () => {
  it('matches IPv4 CIDR ranges (/8, /24, /32) and rejects outsiders', () => {
    const match = createCidrMatcher(['10.0.0.0/8', '192.168.1.0/24', '203.0.113.7/32']);
    expect(match('10.255.1.2')).toBe(true);        // inside /8
    expect(match('11.0.0.1')).toBe(false);         // just outside /8
    expect(match('192.168.1.200')).toBe(true);     // inside /24
    expect(match('192.168.2.1')).toBe(false);      // outside /24
    expect(match('203.0.113.7')).toBe(true);       // exact /32
    expect(match('203.0.113.8')).toBe(false);      // /32 excludes neighbors
  });

  it('does not string-prefix match (the old bug)', () => {
    const match = createCidrMatcher(['10.0.0.0/24']);
    // '10.0.0.' string-prefix would wrongly match 10.0.0.99 AND '10.0.01.1'-style
    // lookalikes; real CIDR math must exclude 10.0.1.x.
    expect(match('10.0.0.99')).toBe(true);
    expect(match('10.0.1.1')).toBe(false);
  });

  it('normalizes IPv6-mapped IPv4 keys before matching', () => {
    const match = createCidrMatcher(['10.0.0.0/24']);
    expect(match('::ffff:10.0.0.5')).toBe(true);
    expect(match('::ffff:10.0.1.5')).toBe(false);
  });

  it('supports bare IPs (IPv4 and IPv6) as exact matches', () => {
    const match = createCidrMatcher(['203.0.113.7', '2001:db8::1']);
    expect(match('203.0.113.7')).toBe(true);
    expect(match('203.0.113.8')).toBe(false);
    expect(match('2001:db8::1')).toBe(true);
    expect(match('2001:DB8::1')).toBe(true); // case-insensitive
    expect(match('2001:db8::2')).toBe(false);
  });

  it('never matches garbage keys', () => {
    const match = createCidrMatcher(['10.0.0.0/8']);
    expect(match('not-an-ip')).toBe(false);
    expect(match('')).toBe(false);
  });

  it('throws on invalid entries at construction', () => {
    expect(() => createCidrMatcher(['10.0.0.'])).toThrow(/Invalid skipCidrs entry/);
    expect(() => createCidrMatcher(['10.0.0.0/33'])).toThrow(/Invalid skipCidrs entry/);
    expect(() => createCidrMatcher(['fd00::/8'])).toThrow(/Invalid skipCidrs entry/); // IPv6 CIDR unsupported
  });
});
