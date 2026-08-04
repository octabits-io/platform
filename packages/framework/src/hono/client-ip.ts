/**
 * Trusted-proxy client-IP middleware: derives `clientIp` on every request via
 * the framework-neutral resolver in `../server/client-ip` (see there for the
 * trust-walk semantics); typically used to key rate limiting.
 *
 * The direct connection IP is runtime-specific. By default it is read via
 * Hono's Bun conninfo helper (`hono/bun`), lazily and fault-tolerantly — under
 * a non-Bun runtime (vitest on Node) it resolves to `undefined`, which the
 * resolver treats as `'unknown'` unless `trustedProxies` includes `'*'`. Tests
 * and other runtimes inject `getDirectIp` instead.
 *
 * Mount it BEFORE the rate-limit middleware so the key generator can read
 * `c.get('clientIp')`.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createClientIpResolver } from '../server/client-ip';

/** The Env contribution this middleware makes. */
export type ClientIpEnv = { Variables: { clientIp: string } };

export interface ClientIpMiddlewareOptions {
  /** Trusted proxy list — IPs, CIDRs, or `'*'`. Default `[]` (trust nothing). */
  trustedProxies?: string[];
  /**
   * Direct-connection IP source. Default: Bun conninfo via `hono/bun`
   * (`undefined` off-Bun). Inject for tests or other runtimes.
   */
  getDirectIp?: (c: Context) => string | undefined | Promise<string | undefined>;
}

// `hono/bun` is NOT import-safe off-Bun (it references the Bun global at
// module scope), so the adapter is loaded lazily on first use and the failure
// is cached — off-Bun every request resolves to "no direct IP" without a
// per-request import attempt.
let loadBunConnInfo: Promise<((c: Context) => string | undefined) | null> | undefined;

function bunDirectIp(c: Context): Promise<string | undefined> {
  loadBunConnInfo ??= import('hono/bun').then(
    ({ getConnInfo }) => (ctx: Context) => {
      try {
        return getConnInfo(ctx).remote.address ?? undefined;
      } catch {
        return undefined;
      }
    },
    () => null,
  );
  return loadBunConnInfo.then((read) => read?.(c) ?? undefined);
}

export function createClientIpMiddleware(options: ClientIpMiddlewareOptions = {}): MiddlewareHandler<ClientIpEnv> {
  const { trustedProxies = [], getDirectIp = bunDirectIp } = options;
  const resolveClientIp = createClientIpResolver(trustedProxies);

  return async (c, next) => {
    const directIp = await getDirectIp(c);
    c.set('clientIp', resolveClientIp(directIp, c.req.raw.headers.get('x-forwarded-for')));
    await next();
  };
}
