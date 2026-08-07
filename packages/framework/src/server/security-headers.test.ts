/**
 * Security-headers core: the option→header-map resolution. `./hono`'s
 * middleware only copies this map onto `c.res`, so the policy decisions
 * (defaults, the `false` opt-outs, the production-gated HSTS) are pinned here.
 *
 * Previously covered only through the deleted Elysia plugin's suite; the
 * assertions moved to the core they were always about.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildSecurityHeaders } from './security-headers';

describe('buildSecurityHeaders', () => {
  afterEach(() => {
    delete process.env.PRODUCTION;
    delete process.env.NODE_ENV;
  });

  it('emits the hardening defaults, and no HSTS outside production', () => {
    const headers = buildSecurityHeaders({ production: false });
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['X-XSS-Protection']).toBe('0'); // legacy filter disabled (XS-Leaks)
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('emits HSTS in production', () => {
    expect(buildSecurityHeaders({ production: true })['Strict-Transport-Security']).toContain(
      'max-age=',
    );
  });

  it('defaults `production` to PRODUCTION=true without NODE_ENV', () => {
    process.env.PRODUCTION = 'true';
    expect(buildSecurityHeaders()['Strict-Transport-Security']).toContain('max-age=');
  });

  it('never emits HSTS when explicitly disabled, even in production', () => {
    expect(
      buildSecurityHeaders({ production: true, hsts: false })['Strict-Transport-Security'],
    ).toBeUndefined();
  });

  it('supports overriding / disabling the optional headers', () => {
    const headers = buildSecurityHeaders({
      production: false,
      csp: "default-src 'self'",
      permissionsPolicy: 'camera=()',
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: 'cross-origin',
    });
    expect(headers['Content-Security-Policy']).toBe("default-src 'self'");
    expect(headers['Permissions-Policy']).toBe('camera=()');
    expect(headers['Cross-Origin-Opener-Policy']).toBeUndefined();
    expect(headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });
});
