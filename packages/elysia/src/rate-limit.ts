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
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { rateLimit, type Options } from 'elysia-rate-limit';
import type { Logger } from '@octabits-io/foundation/logger';
import { normalizeIp } from './client-ip';

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

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map(Number);
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

interface Ipv4Range {
  base: number;
  mask: number;
}

/**
 * Build an IP matcher from `skipCidrs` entries: IPv4 CIDR (`a.b.c.d/nn`) and
 * bare IPv4/IPv6 addresses (exact match). Throws on invalid entries.
 * Exposed for direct use/testing.
 */
export function createCidrMatcher(entries: string[]): (ip: string) => boolean {
  const ranges: Ipv4Range[] = [];
  const exact = new Set<string>();

  for (const entry of entries) {
    const trimmed = entry.trim();
    const slash = trimmed.indexOf('/');
    if (slash >= 0) {
      const base = normalizeIp(trimmed.slice(0, slash));
      const bits = Number(trimmed.slice(slash + 1));
      const baseInt = base === null ? null : ipv4ToInt(base);
      if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
        throw new Error(`Invalid skipCidrs entry "${entry}" — expected IPv4 CIDR (a.b.c.d/nn) or a bare IP address`);
      }
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      ranges.push({ base: (baseInt & mask) >>> 0, mask });
      continue;
    }
    const normalized = normalizeIp(trimmed);
    if (normalized === null) {
      throw new Error(`Invalid skipCidrs entry "${entry}" — expected IPv4 CIDR (a.b.c.d/nn) or a bare IP address`);
    }
    exact.add(normalized);
  }

  return (ip: string): boolean => {
    const normalized = normalizeIp(ip);
    if (normalized === null) return false;
    if (exact.has(normalized)) return true;
    const asInt = ipv4ToInt(normalized);
    if (asInt === null) return false;
    return ranges.some((range) => ((asInt & range.mask) >>> 0) === range.base);
  };
}

/** Constant-time string comparison (length mismatch short-circuits). */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

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
  } = options;

  const matchesSkipCidr = skipCidrs.length > 0 ? createCidrMatcher(skipCidrs) : null;

  const config: Partial<Options> = {
    max,
    duration: windowMs,
    ...(scoping ? { scoping } : {}),
    skip: (req, key) => {
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
