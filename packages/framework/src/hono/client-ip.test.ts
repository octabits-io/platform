/**
 * Client-IP middleware: derivation of `c.get('clientIp')` through the shared
 * trust-walk resolver. The resolver's full semantics are covered by the
 * elysia-suite tests over the same core; here we pin the Hono wiring — the
 * injected direct-IP seam, XFF handling per trust mode, and the off-Bun
 * fallback of the default seam.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createClientIpMiddleware, type ClientIpEnv } from './client-ip';

function appWithDirectIp(directIp: string | undefined, trustedProxies?: string[]) {
  const app = new Hono<ClientIpEnv>();
  app.use(createClientIpMiddleware({ trustedProxies, getDirectIp: () => directIp }));
  app.get('/', (c) => c.json({ clientIp: c.get('clientIp') }));
  return app;
}

async function resolvedIp(app: Hono<ClientIpEnv>, headers: Record<string, string> = {}): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/', { headers }));
  const body = (await res.json()) as { clientIp: string };
  return body.clientIp;
}

describe('createClientIpMiddleware', () => {
  it('uses the direct connection IP and ignores X-Forwarded-For when nothing is trusted', async () => {
    const app = appWithDirectIp('203.0.113.7');
    expect(await resolvedIp(app, { 'x-forwarded-for': '198.51.100.1' })).toBe('203.0.113.7');
  });

  it('walks X-Forwarded-For rightmost-untrusted when the direct peer is a trusted proxy', async () => {
    const app = appWithDirectIp('10.0.0.1', ['10.0.0.0/8']);
    expect(await resolvedIp(app, { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })).toBe('198.51.100.1');
  });

  it("trusts the whole chain under '*' and uses the leftmost valid entry", async () => {
    const app = appWithDirectIp(undefined, ['*']);
    expect(await resolvedIp(app, { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })).toBe('198.51.100.1');
  });

  it("falls back to 'unknown' when no direct IP is available and nothing else is trusted", async () => {
    const app = appWithDirectIp(undefined);
    expect(await resolvedIp(app, { 'x-forwarded-for': '198.51.100.1' })).toBe('unknown');
  });

  it("default direct-IP seam degrades to 'unknown' off-Bun instead of throwing", async () => {
    const app = new Hono<ClientIpEnv>();
    app.use(createClientIpMiddleware());
    app.get('/', (c) => c.json({ clientIp: c.get('clientIp') }));
    expect(await resolvedIp(app)).toBe('unknown');
  });
});
