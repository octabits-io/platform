/**
 * Security response-headers plugin.
 *
 * Sets the standard hardening headers on every response — including error
 * responses (thrown errors, 404s): the headers are staged in `onRequest`,
 * before routing and any handler, so they end up on whatever response Elysia
 * ultimately builds. Headers: `X-Frame-Options`, `X-Content-Type-Options`,
 * `Referrer-Policy`, `X-XSS-Protection: 0` (the legacy filter is disabled —
 * it introduced XS-Leaks), `Permissions-Policy`, `Cross-Origin-Opener-Policy`,
 * `Cross-Origin-Resource-Policy`, a restrictive `Content-Security-Policy`,
 * and (in production) HSTS. Zero domain coupling.
 */
import { Elysia } from 'elysia';
import { isProduction } from './config';

export interface SecurityHeadersOptions {
  /** `Content-Security-Policy` value. Defaults to a restrictive JSON-API policy. */
  csp?: string;
  /** `Strict-Transport-Security` value, or `false` to never emit it. Applied only when `production`. */
  hsts?: string | false;
  /** Whether to emit HSTS. Defaults to this package's `isProduction()` (`NODE_ENV === 'production'` OR `PRODUCTION` truthy). */
  production?: boolean;
  /** `Permissions-Policy` value, or `false` to omit. Defaults to a restrictive deny list. */
  permissionsPolicy?: string | false;
  /** `Cross-Origin-Opener-Policy` value, or `false` to omit. Defaults to `same-origin`. */
  crossOriginOpenerPolicy?: string | false;
  /** `Cross-Origin-Resource-Policy` value, or `false` to omit. Defaults to `same-origin`. */
  crossOriginResourcePolicy?: string | false;
}

/** Restrictive default suited to a JSON API that serves no browser-rendered content. */
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";
const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains';
/** Deny the powerful features a JSON API never needs. */
const DEFAULT_PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

export function createSecurityHeadersPlugin(options: SecurityHeadersOptions = {}) {
  const csp = options.csp ?? DEFAULT_CSP;
  const hsts = options.hsts ?? DEFAULT_HSTS;
  const production = options.production ?? isProduction();
  const permissionsPolicy = options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY;
  const coop = options.crossOriginOpenerPolicy ?? 'same-origin';
  const corp = options.crossOriginResourcePolicy ?? 'same-origin';

  // `onRequest` runs before routing and before any handler/error path, and the
  // staged `set.headers` are applied to success AND error responses alike
  // (thrown errors, validation failures, and route-miss 404s included) —
  // unlike `onAfterHandle`, which never fires on error paths.
  return new Elysia({ name: 'security-headers' }).onRequest(({ set }) => {
    // Prevent clickjacking.
    set.headers['X-Frame-Options'] = 'DENY';
    // Prevent MIME-type sniffing.
    set.headers['X-Content-Type-Options'] = 'nosniff';
    // Control referrer information.
    set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
    // Explicitly disable the legacy XSS auditor (it enabled XS-Leaks; '0' is
    // the modern recommendation).
    set.headers['X-XSS-Protection'] = '0';
    // Lock down powerful browser features.
    if (permissionsPolicy) {
      set.headers['Permissions-Policy'] = permissionsPolicy;
    }
    // Process isolation / cross-origin embedding.
    if (coop) {
      set.headers['Cross-Origin-Opener-Policy'] = coop;
    }
    if (corp) {
      set.headers['Cross-Origin-Resource-Policy'] = corp;
    }
    // Content Security Policy.
    set.headers['Content-Security-Policy'] = csp;
    // Enforce HTTPS in production.
    if (production && hsts) {
      set.headers['Strict-Transport-Security'] = hsts;
    }
  });
}
