/**
 * The on-Bun conninfo-failure branch of `createClientIpMiddleware`.
 *
 * Regression origin: a consumer's Bun adapters handed the server to Hono as
 * `app.fetch(request, { bunServer })`, but `hono/bun`'s `getBunServer` reads
 * `'server' in c.env ? c.env.server : c.env` — so it fell through to the env
 * object itself, `requestIP` was missing, `getConnInfo` threw, and the catch
 * in the direct-IP seam swallowed it. Every request resolved `clientIp` to the
 * literal string `'unknown'`, which silently collapsed each *per-IP* rate
 * limiter into ONE global bucket: two unrelated signups within the window
 * locked out the whole internet, and the limiter still looked healthy.
 *
 * Nothing logged, and a Node test run could not tell the difference — off-Bun
 * the seam legitimately yields `undefined` too. The one-shot warning is what
 * separates "not on Bun" (fine) from "on Bun and misconfigured" (a security
 * downgrade), so it gets its own file: `vi.mock` is file-scoped, and mocking
 * `hono/bun` in `./client-ip.test.ts` would defeat the off-Bun tests there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { __resetClientIpWarningForTests, createClientIpMiddleware, type ClientIpEnv } from './client-ip';

// Off-Bun the lazy `import('hono/bun')` rejects (the module touches the Bun
// global at import time). Mocking it makes the import RESOLVE, as it does
// under Bun, while `getConnInfo` throws the exact TypeError the real adapter
// throws when the server never reached `c.env`.
vi.mock('hono/bun', () => ({
  getConnInfo: () => {
    throw new TypeError('server.requestIP is not a function.');
  },
}));

function appWithDefaultSeam(logger?: { warn: (message: string) => void }) {
  const app = new Hono<ClientIpEnv>();
  app.use(createClientIpMiddleware(logger ? { logger } : {}));
  app.get('/', (c) => c.json({ clientIp: c.get('clientIp') }));
  return app;
}

async function resolvedIp(app: Hono<ClientIpEnv>): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/'));
  return ((await res.json()) as { clientIp: string }).clientIp;
}

describe('createClientIpMiddleware — Bun conninfo failure', () => {
  beforeEach(() => {
    __resetClientIpWarningForTests();
  });

  it('still fails safe: the request succeeds, the IP is just unknowable', async () => {
    expect(await resolvedIp(appWithDefaultSeam({ warn: () => {} }))).toBe('unknown');
  });

  it('warns once per process, not once per request', async () => {
    const warn = vi.fn();
    const app = appWithDefaultSeam({ warn });

    await resolvedIp(app);
    await resolvedIp(app);
    await resolvedIp(app);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names the concrete fix in the warning', async () => {
    const warn = vi.fn();
    await resolvedIp(appWithDefaultSeam({ warn }));

    const message = warn.mock.calls[0]?.[0] as string;
    // The symptom operators would otherwise have to infer from a 429 storm…
    expect(message).toContain('single global bucket');
    // …and the one-line change that fixes it.
    expect(message).toContain('app.fetch(request, { server })');
  });

  it('falls back to console.warn when no logger is supplied', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await resolvedIp(appWithDefaultSeam());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
