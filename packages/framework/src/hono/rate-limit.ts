/**
 * Rate-limit middleware, built entirely from the framework-neutral cores in
 * `../server/rate-limit` (fixed-window counter, CIDR skip matcher,
 * timing-safe secret comparison) — no rate-limit vendor dependency, unlike the
 * Elysia layer this replaced, which wrapped `elysia-rate-limit`.
 *
 * Reproduces the standard configuration: a fixed window keyed on the real
 * client IP (from `./client-ip`'s `c.get('clientIp')`), a `{ key, message }`
 * 429 JSON body (+ `Retry-After`), and skip rules for trusted internal
 * callers — an internal-secret header (compared timing-safely), trusted CIDR
 * ranges, and exempted path prefixes (self-limiting endpoints, e.g. a mounted
 * SSE handler).
 *
 * There is no `scoping` option: on Hono, WHERE you mount the middleware is the
 * scope. Mount app-wide for the skeleton behavior, or on a sub-app for a
 * per-group limiter with its own counter (stacks with an app-wide one).
 *
 * ```ts
 * app.use(createClientIpMiddleware({ trustedProxies }));
 * app.use(createRateLimitMiddleware({ max: 100, windowMs: 60_000, skipCidrs }));
 * ```
 *
 * When `keyByClientIp` is enabled but `clientIp` is missing (client-IP
 * middleware not mounted, or mounted after the limiter), every request falls
 * into a single shared `'unknown'` bucket — the limiter then throttles all
 * traffic collectively. A warning is logged once when this is detected.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Logger } from '../logger/index.ts';
import {
  createCidrMatcher,
  createFixedWindowLimiter,
  timingSafeStringEqual,
} from '../server/rate-limit';

export interface RateLimitMiddlewareOptions {
  /** Maximum number of requests allowed per key within the window. */
  max: number;
  /** Window length in milliseconds. Defaults to `60_000` (1 minute). */
  windowMs?: number;
  /**
   * Trusted IP ranges. Each entry is an IPv4 CIDR (`a.b.c.d/nn`) or a bare IP
   * address (IPv4 or IPv6, matched exactly). A request whose key (client IP)
   * falls inside any entry is exempt. Invalid entries throw at construction.
   * Default `[]`.
   */
  skipCidrs?: string[];
  /**
   * Shared secret for internal server-to-server callers. When set, a request
   * carrying this exact value in `internalSecretHeader` bypasses the limiter.
   * Compared with a timing-safe equality check.
   */
  internalSecret?: string;
  /** Header carrying the internal secret. Defaults to `x-api-secret`. */
  internalSecretHeader?: string;
  /**
   * When `true` (default) the limiter is keyed on `c.get('clientIp')`
   * (requires `./client-ip`). Pass a function to key on something else
   * entirely (e.g. a token subject).
   */
  keyByClientIp?: boolean | ((c: Context) => string);
  /**
   * Path prefixes exempt from the limiter. A request whose pathname equals an
   * entry or starts with `entry + '/'` is skipped entirely. Default `[]`.
   */
  skipPaths?: string[];
  /** `key` field of the 429 JSON body. Defaults to `rate_limit_exceeded`. */
  errorKey?: string;
  /** `message` field of the 429 JSON body. Defaults to a generic notice. */
  errorMessage?: string;
  /** Diagnostics (missing-clientIp warning). Falls back to `console.warn`. */
  logger?: Logger;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_INTERNAL_SECRET_HEADER = 'x-api-secret';
const DEFAULT_ERROR_KEY = 'rate_limit_exceeded';
const DEFAULT_ERROR_MESSAGE = 'Too many requests, please try again later';

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions): MiddlewareHandler {
  const {
    max,
    windowMs = DEFAULT_WINDOW_MS,
    skipCidrs = [],
    internalSecret,
    internalSecretHeader = DEFAULT_INTERNAL_SECRET_HEADER,
    keyByClientIp = true,
    skipPaths = [],
    errorKey = DEFAULT_ERROR_KEY,
    errorMessage = DEFAULT_ERROR_MESSAGE,
    logger,
  } = options;

  const matchesSkipCidr = skipCidrs.length > 0 ? createCidrMatcher(skipCidrs) : null;
  const limiter = createFixedWindowLimiter({ max, windowMs });

  let warnedMissingClientIp = false;
  const keyOf = (c: Context): string => {
    if (typeof keyByClientIp === 'function') return keyByClientIp(c);
    if (!keyByClientIp) return 'global';
    const clientIp = c.get('clientIp' as never) as string | undefined;
    if (clientIp === undefined) {
      if (!warnedMissingClientIp) {
        warnedMissingClientIp = true;
        const warning =
          'createRateLimitMiddleware: keyByClientIp is enabled but c.get("clientIp") is undefined — '
          + 'all requests share one "unknown" bucket. Mount createClientIpMiddleware before the rate limiter.';
        if (logger) logger.warn(warning);
        else console.warn(warning);
      }
      return 'unknown';
    }
    return clientIp;
  };

  return async (c, next) => {
    // Exempted path prefixes (self-limiting endpoints, e.g. mounted SSE).
    if (skipPaths.length > 0) {
      const pathname = c.req.path;
      if (skipPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
        return next();
      }
    }
    // Internal server-to-server callers (e.g. SSR) bypass via a shared secret.
    if (internalSecret) {
      const provided = c.req.raw.headers.get(internalSecretHeader);
      if (provided !== null && timingSafeStringEqual(provided, internalSecret)) {
        return next();
      }
    }

    const key = keyOf(c);
    // Trusted ranges bypass by client-IP CIDR match.
    if (matchesSkipCidr && matchesSkipCidr(key)) {
      return next();
    }

    const hit = limiter.hit(key);
    if (hit.limited) {
      const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
      return c.json({ key: errorKey, message: errorMessage }, 429, {
        'Retry-After': String(retryAfterSeconds),
      });
    }

    await next();
  };
}
