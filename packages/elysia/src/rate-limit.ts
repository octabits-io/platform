/**
 * Rate-limit plugin factory.
 *
 * Thin, domain-agnostic wrapper around `elysia-rate-limit` that reproduces the
 * standard API rate-limit configuration: a fixed window keyed on the real client
 * IP (from the `client-ip` plugin's `derived.clientIp`), a `{ key, message }` 429
 * JSON body, and a `skip` predicate that bypasses the limiter for trusted internal
 * callers — either an internal-secret request header **or** a client IP that falls
 * under one of a set of trusted CIDR prefixes.
 *
 * The domain seam (which secret, which header, which prefixes, the limit and
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
 */
import { rateLimit, type Options } from 'elysia-rate-limit';

export interface RateLimitOptions {
  /** Maximum number of requests allowed per key within the window. */
  max: number;
  /** Window length in milliseconds. Defaults to `60_000` (1 minute). */
  windowMs?: number;
  /**
   * Trusted CIDR **prefixes** (string prefixes, matched via `key.startsWith(cidr)`).
   * A request whose key (client IP) starts with any of these is exempt. Default `[]`.
   */
  skipCidrs?: string[];
  /**
   * Shared secret for internal server-to-server callers. When set, a request
   * carrying this exact value in `internalSecretHeader` bypasses the limiter.
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
  } = options;

  const config: Partial<Options> = {
    max,
    duration: windowMs,
    ...(scoping ? { scoping } : {}),
    skip: (req, key) => {
      // Internal server-to-server callers (e.g. SSR) bypass via a shared secret.
      if (internalSecret && req.headers.get(internalSecretHeader) === internalSecret) {
        return true;
      }
      // Trusted CIDR prefixes bypass by client-IP prefix match.
      if (skipCidrs.length > 0 && key) {
        return skipCidrs.some((cidr) => key.startsWith(cidr));
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
    config.generator = (_req, _server, derived) =>
      (derived as { clientIp?: string })?.clientIp ?? 'unknown';
  }

  return rateLimit(config);
}
