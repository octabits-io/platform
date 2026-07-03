/**
 * Security response-headers plugin.
 *
 * Sets the standard hardening headers on every response: `X-Frame-Options`,
 * `X-Content-Type-Options`, `Referrer-Policy`, `X-XSS-Protection`, a restrictive
 * `Content-Security-Policy`, and (in production) HSTS. Zero domain coupling.
 */
import { Elysia } from 'elysia';

export interface SecurityHeadersOptions {
  /** `Content-Security-Policy` value. Defaults to a restrictive JSON-API policy. */
  csp?: string;
  /** `Strict-Transport-Security` value, or `false` to never emit it. Applied only when `production`. */
  hsts?: string | false;
  /** Whether to emit HSTS. Defaults to `process.env.NODE_ENV === 'production'`. */
  production?: boolean;
}

/** Restrictive default suited to a JSON API that serves no browser-rendered content. */
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";
const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains';

export function createSecurityHeadersPlugin(options: SecurityHeadersOptions = {}) {
  const csp = options.csp ?? DEFAULT_CSP;
  const hsts = options.hsts ?? DEFAULT_HSTS;
  const production = options.production ?? process.env.NODE_ENV === 'production';

  // `as: 'global'` so the headers apply to every response in the app the plugin is
  // mounted into — not just routes defined on this (route-less) plugin instance.
  return new Elysia({ name: 'security-headers' }).onAfterHandle({ as: 'global' }, ({ set }) => {
    // Prevent clickjacking.
    set.headers['X-Frame-Options'] = 'DENY';
    // Prevent MIME-type sniffing.
    set.headers['X-Content-Type-Options'] = 'nosniff';
    // Control referrer information.
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    // Legacy XSS filter (still useful for older browsers).
    set.headers['X-XSS-Protection'] = '1; mode=block';
    // Content Security Policy.
    set.headers['Content-Security-Policy'] = csp;
    // Enforce HTTPS in production.
    if (production && hsts) {
      set.headers['Strict-Transport-Security'] = hsts;
    }
  });
}
