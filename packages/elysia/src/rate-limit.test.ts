import { describe, it, expect } from 'vitest';
import { Elysia } from 'elysia';
import { createRateLimit } from './rate-limit';
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

  it('skips rate limiting for client IPs under a trusted CIDR prefix', async () => {
    const app = new Elysia()
      // trustAll so the forwarded IP is honored and surfaces as derived.clientIp
      .use(createClientIpPlugin(['*']))
      .use(createRateLimit({ max: 1, skipCidrs: ['10.0.0.'] }))
      .get('/', () => 'ok');
    const headers = { 'x-forwarded-for': '10.0.0.5' };
    const first = await app.handle(new Request('http://localhost/', { headers }));
    const second = await app.handle(new Request('http://localhost/', { headers }));
    // Client IP 10.0.0.5 matches the '10.0.0.' prefix → limiter bypassed.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('still limits client IPs outside the trusted CIDR prefixes', async () => {
    const app = new Elysia()
      .use(createClientIpPlugin(['*']))
      .use(createRateLimit({ max: 1, skipCidrs: ['10.0.0.'] }))
      .get('/', () => 'ok');
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    const first = await app.handle(new Request('http://localhost/', { headers }));
    const second = await app.handle(new Request('http://localhost/', { headers }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
