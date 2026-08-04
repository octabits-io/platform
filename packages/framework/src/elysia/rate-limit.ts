/**
 * Rate-limit plugin factory.
 *
 * Thin, domain-agnostic wrapper around `elysia-rate-limit` that reproduces the
 * standard API rate-limit configuration: a fixed window keyed on the real client
 * IP (from the `client-ip` plugin's `derived.clientIp`), a `{ key, message }` 429
 * JSON body, and a `skip` predicate that bypasses the limiter for trusted internal
 * callers — either an internal-secret request header (compared timing-safely)
 * **or** a client IP inside one of a set of trusted CIDR ranges.
 *
 * The skip matcher and the timing-safe comparison are framework-neutral cores
 * in `../server/rate-limit` (shared with the `./hono` limiter);
 * `createCidrMatcher` is re-exported here for backwards compatibility.
 *
 * The domain seam (which secret, which header, which ranges, the limit and
 * window) is fully parameterized — nothing here is coupled to a specific product
 * or environment.
 *
 * Pairs with `createClientIpPlugin`, which supplies `derived.clientIp`. Mount the
 * client-IP plugin **before** this one so the key generator can read it:
 *
 * ```ts
 * app
 *   .use(createClientIpPlugin(trustedProxies))
 *   .use(createRateLimit({ max: 100, windowMs: 60_000, skipCidrs }))
 * ```
 *
 * When `keyByClientIp` is enabled but `derived.clientIp` is missing (client-IP
 * plugin not mounted, or mounted after the limiter), every request falls into a
 * single shared `'unknown'` bucket — the limiter then throttles all traffic
 * collectively. A warning is logged once when this is detected.
 */
import { rateLimit, type Options } from 'elysia-rate-limit';
import type { Logger } from '../logger/index.ts';
import { createCidrMatcher, timingSafeStringEqual } from '../server/rate-limit';

export { createCidrMatcher };

export interface RateLimitOptions {
  /** Maximum number of requests allowed per key within the window. */
  max: number;
  /** Window length in milliseconds. Defaults to `60_000` (1 minute). */
  windowMs?: number;
  /**
   * Trusted IP ranges. Each entry is an IPv4 CIDR (`a.b.c.d/nn`) or a bare IP
   * address (IPv4 or IPv6, matched exactly; IPv4 → `/32`). A request whose key
   * (client IP) falls inside any entry is exempt. `::ffff:`-mapped IPv4 keys
   * are normalized to dotted-quad before matching. Invalid entries (including
   * IPv6 CIDR, which is not supported) throw at construction. Default `[]`.
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
   * When `true` (default) the limiter is keyed on `derived.clientIp` (requires the
   * client-IP plugin). When `false`, no generator is set and the underlying
   * library's default key generator is used.
   */
  keyByClientIp?: boolean;
  /**
   * Path prefixes exempt from the limiter. A request whose URL pathname equals
   * an entry or starts with `entry + '/'` is skipped entirely. Intended for
   * routes that live outside the plugin hook chain and enforce their own
   * limits — e.g. a `.mount()`ed SSE endpoint (mounted fetch handlers never
   * see the client-IP plugin, so their requests would all share one 'unknown'
   * bucket; such endpoints cap per subscriber instead). Default `[]`.
   */
  skipPaths?: string[];
  /** `key` field of the 429 JSON body. Defaults to `rate_limit_exceeded`. */
  errorKey?: string;
  /** `message` field of the 429 JSON body. Defaults to a generic notice. */
  errorMessage?: string;
  /**
   * Plugin scope (elysia-rate-limit `scoping`). The default `'global'` applies the
   * limiter app-wide — the app skeleton's usage. Pass `'scoped'` for a per-route
   * limiter mounted inside a route group: it then guards only that group, with its
   * own counter, and can be tighter than (and stacks with) the app-wide limit.
   */
  scoping?: 'global' | 'scoped';
  /** Diagnostics (missing-clientIp warning). Falls back to `console.warn`. */
  logger?: Logger;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_INTERNAL_SECRET_HEADER = 'x-api-secret';
const DEFAULT_ERROR_KEY = 'rate_limit_exceeded';
const DEFAULT_ERROR_MESSAGE = 'Too many requests, please try again later';

export function createRateLimit(options: RateLimitOptions) {
  const {
    max,
    windowMs = DEFAULT_WINDOW_MS,
    skipCidrs = [],
    internalSecret,
    internalSecretHeader = DEFAULT_INTERNAL_SECRET_HEADER,
    keyByClientIp = true,
    errorKey = DEFAULT_ERROR_KEY,
    errorMessage = DEFAULT_ERROR_MESSAGE,
    scoping,
    logger,
    skipPaths = [],
  } = options;

  const matchesSkipCidr = skipCidrs.length > 0 ? createCidrMatcher(skipCidrs) : null;

  const config: Partial<Options> = {
    max,
    duration: windowMs,
    ...(scoping ? { scoping } : {}),
    skip: (req, key) => {
      // Exempted path prefixes (self-limiting endpoints, e.g. mounted SSE).
      if (skipPaths.length > 0) {
        const pathname = new URL(req.url).pathname;
        if (skipPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
          return true;
        }
      }
      // Internal server-to-server callers (e.g. SSR) bypass via a shared secret.
      if (internalSecret) {
        const provided = req.headers.get(internalSecretHeader);
        if (provided !== null && timingSafeStringEqual(provided, internalSecret)) {
          return true;
        }
      }
      // Trusted ranges bypass by client-IP CIDR match.
      if (matchesSkipCidr && key) {
        return matchesSkipCidr(key);
      }
      return false;
    },
    errorResponse: new Response(
      JSON.stringify({ key: errorKey, message: errorMessage }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ),
  };

  // Key on the real client IP resolved by the client-IP plugin. Omitting the
  // generator falls back to the library default (direct connection IP).
  if (keyByClientIp) {
    let warnedMissingClientIp = false;
    config.generator = (_req, _server, derived) => {
      const clientIp = (derived as { clientIp?: string })?.clientIp;
      if (clientIp === undefined) {
        if (!warnedMissingClientIp) {
          warnedMissingClientIp = true;
          const warning =
            'createRateLimit: keyByClientIp is enabled but derived.clientIp is undefined — '
            + 'all requests share one "unknown" bucket. Mount createClientIpPlugin before the rate limiter.';
          if (logger) logger.warn(warning);
          else console.warn(warning);
        }
        return 'unknown';
      }
      return clientIp;
    };
  }

  return rateLimit(config);
}
