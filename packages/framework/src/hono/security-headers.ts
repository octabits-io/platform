/**
 * Hono port of the `./elysia` security-headers plugin (same contract, Hono idiom).
 *
 * The header map comes from the framework-neutral `buildSecurityHeaders`
 * unchanged; only the application mechanism differs. Elysia stages headers in
 * `onRequest` so they land on whatever response is ultimately built; on Hono
 * the same guarantee comes from setting them on `c.res` AFTER `await next()`
 * — by then `c.res` is the final response on success AND error paths alike
 * (a downstream error is converted by `onError` at the inner compose frame
 * before this middleware unwinds), and on 404s (`notFound` response).
 * Mount it first (outermost).
 */
import type { MiddlewareHandler } from 'hono';
import { buildSecurityHeaders, type SecurityHeadersOptions } from '../server/security-headers';

export type { SecurityHeadersOptions };

export function createSecurityHeadersMiddleware(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const headers = Object.entries(buildSecurityHeaders(options));

  return async (c, next) => {
    await next();
    for (const [name, value] of headers) c.res.headers.set(name, value);
  };
}
