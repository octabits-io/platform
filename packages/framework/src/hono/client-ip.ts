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
import type { Logger } from '../logger/index.ts';
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
  /**
   * Diagnostics for the on-Bun conninfo failure below. Falls back to
   * `console.warn`.
   */
  logger?: Pick<Logger, 'warn'>;
}

// `hono/bun` is NOT import-safe off-Bun (it references the Bun global at
// module scope), so the adapter is loaded lazily on first use and the failure
// is cached — off-Bun every request resolves to "no direct IP" without a
// per-request import attempt.
let loadBunConnInfo: Promise<((c: Context) => string | undefined) | null> | undefined;

/**
 * Distinguishes the two ways `getDirectIp` can come back empty:
 *
 *   - the `hono/bun` import failed → we are simply not on Bun (vitest on Node),
 *     which is expected and silent;
 *   - the import SUCCEEDED but `getConnInfo` threw → we ARE on Bun and the
 *     server object never reached `c.env`, so no request will ever resolve a
 *     real IP.
 *
 * The second case is a silent security downgrade, not a runtime quirk: every
 * request resolves to the literal string `'unknown'`, which turns every
 * per-IP rate limiter keyed on `clientIp` into ONE global bucket shared by the
 * whole internet — the limit still "works", it just meters everybody together.
 * Nothing else surfaces it, so warn once (per process) with the fix.
 */
let warnedConnInfoFailed = false;

function warnConnInfoFailed(cause: unknown, logger?: Pick<Logger, 'warn'>): void {
  if (warnedConnInfoFailed) return;
  warnedConnInfoFailed = true;
  const warning =
    'createClientIpMiddleware: running on Bun but hono/bun getConnInfo failed '
    + `(${cause instanceof Error ? cause.message : String(cause)}) — every request will resolve `
    + "clientIp to 'unknown', collapsing per-IP rate limiting into a single global bucket. "
    + 'Pass the Bun server as `server` in the fetch env: '
    + 'Bun.serve({ fetch: (request, server) => app.fetch(request, { server }) }).';
  if (logger) logger.warn(warning);
  else console.warn(warning);
}

function createBunDirectIp(logger?: Pick<Logger, 'warn'>) {
  return function bunDirectIp(c: Context): Promise<string | undefined> {
    loadBunConnInfo ??= import('hono/bun').then(
      ({ getConnInfo }) => (ctx: Context) => {
        try {
          return getConnInfo(ctx).remote.address ?? undefined;
        } catch (cause) {
          warnConnInfoFailed(cause, logger);
          return undefined;
        }
      },
      () => null,
    );
    return loadBunConnInfo.then((read) => read?.(c) ?? undefined);
  };
}

export function createClientIpMiddleware(options: ClientIpMiddlewareOptions = {}): MiddlewareHandler<ClientIpEnv> {
  const { trustedProxies = [], logger, getDirectIp = createBunDirectIp(logger) } = options;
  const resolveClientIp = createClientIpResolver(trustedProxies);

  return async (c, next) => {
    const directIp = await getDirectIp(c);
    c.set('clientIp', resolveClientIp(directIp, c.req.raw.headers.get('x-forwarded-for')));
    await next();
  };
}

/** Test seam: reset the once-per-process warning latch. */
export function __resetClientIpWarningForTests(): void {
  warnedConnInfoFailed = false;
  loadBunConnInfo = undefined;
}
