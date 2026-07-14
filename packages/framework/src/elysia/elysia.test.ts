import { describe, it, expect, afterEach } from 'vitest';
import { Elysia } from 'elysia';
import { z } from 'zod';
import { createSecurityHeadersPlugin } from './security-headers';
import { createClientIpPlugin, createClientIpResolver, normalizeIp } from './client-ip';
import {
  SCHEMA_ERROR_RESPONSE,
  CommonErrorResponses,
  errorResponses,
  ALL_ERROR_STATUSES,
} from './responses';
import {
  getStatusCodeForError,
  statusErrorWithSet,
  mapResultError,
  isDbConnectionError,
  ApiError,
  NotFoundError,
  ForbiddenError,
  createErrorHandler,
} from './errors';
import {
  getEnv,
  getEnvOptional,
  getEnvNumber,
  getEnvNumberOptional,
  getEnvBoolean,
  isProduction,
  parseCsv,
  parseCorsOrigins,
} from './config';

describe('getStatusCodeForError', () => {
  it('maps by key convention', () => {
    expect(getStatusCodeForError({ key: 'listing_not_found', message: '' })).toBe(404);
    expect(getStatusCodeForError({ key: 'not_found', message: '' })).toBe(404);
    expect(getStatusCodeForError({ key: 'unauthorized', message: '' })).toBe(401);
    expect(getStatusCodeForError({ key: 'invalid_token', message: '' })).toBe(401);
    expect(getStatusCodeForError({ key: 'permission_denied', message: '' })).toBe(403);
    expect(getStatusCodeForError({ key: 'invalid_email', message: '' })).toBe(400);
    expect(getStatusCodeForError({ key: 'validation_failed', message: '' })).toBe(400);
    expect(getStatusCodeForError({ key: 'missing_field', message: '' })).toBe(422);
    expect(getStatusCodeForError({ key: 'incomplete_profile', message: '' })).toBe(422);
    expect(getStatusCodeForError({ key: 'stripe_not_configured', message: '' })).toBe(422);
    expect(getStatusCodeForError({ key: 'something_weird', message: '' })).toBe(500);
  });

  it('honors statusOverrides over the conventions', () => {
    const overrides = { tenant_not_found: 403, attachment_blocked: 403 };
    // Without overrides, tenant_not_found matches `*_not_found` → 404.
    expect(getStatusCodeForError({ key: 'tenant_not_found', message: '' })).toBe(404);
    // With overrides → 403.
    expect(getStatusCodeForError({ key: 'tenant_not_found', message: '' }, overrides)).toBe(403);
    expect(getStatusCodeForError({ key: 'attachment_blocked', message: '' }, overrides)).toBe(403);
  });
});

describe('statusErrorWithSet', () => {
  afterEach(() => { delete process.env.PRODUCTION; delete process.env.NODE_ENV; });

  it('sets status and returns a copy of the error body', () => {
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, { key: 'listing_not_found', message: 'nope' });
    expect(set.status).toBe(404);
    expect(body).toEqual({ key: 'listing_not_found', message: 'nope' });
  });

  it('applies overrides', () => {
    const set: { status?: number | string } = {};
    statusErrorWithSet(set, { key: 'tenant_not_found', message: 'x' }, { tenant_not_found: 403 });
    expect(set.status).toBe(403);
  });

  it('whitelists response fields — extra enumerable props are never serialized', () => {
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, {
      key: 'invalid_email',
      message: 'bad email',
      cause: { stack: 'internal' },
      dbQuery: 'SELECT secret',
    } as { key: string; message: string });
    expect(body).toEqual({ key: 'invalid_email', message: 'bad email' });
    expect(Object.keys(body)).toEqual(['key', 'message']);
  });

  it('keeps the documented fields property for validation errors', () => {
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, {
      key: 'validation_error',
      message: 'Validation failed',
      fields: [{ path: 'email', message: 'invalid' }],
    } as { key: string; message: string });
    expect(body).toEqual({
      key: 'validation_error',
      message: 'Validation failed',
      fields: [{ path: 'email', message: 'invalid' }],
    });
  });

  it('redacts 5xx messages in production (PRODUCTION=true, no NODE_ENV), keeping the key', () => {
    process.env.PRODUCTION = 'true';
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, { key: 'weird_internal_failure', message: 'pg://user:pass@host exploded' });
    expect(set.status).toBe(500);
    expect(body).toEqual({ key: 'weird_internal_failure', message: 'Internal error' });
  });

  it('does not redact 4xx messages in production', () => {
    process.env.PRODUCTION = 'true';
    const set: { status?: number | string } = {};
    const body = statusErrorWithSet(set, { key: 'invalid_email', message: 'bad email' });
    expect(body.message).toBe('bad email');
  });
});

describe('mapResultError', () => {
  it('returns the right ApiError subclass', () => {
    expect(mapResultError({ key: 'x_not_found', message: 'm' })).toBeInstanceOf(NotFoundError);
    expect(mapResultError({ key: 'permission_denied', message: 'm' })).toBeInstanceOf(ForbiddenError);
    expect(mapResultError({ key: 'boom', message: 'm' })).toBeInstanceOf(ApiError);
    expect(mapResultError({ key: 'tenant_not_found', message: 'm' }, { tenant_not_found: 403 })).toBeInstanceOf(ForbiddenError);
  });
});

describe('isDbConnectionError', () => {
  it('detects node system codes, PG classes, message patterns, and cause chains', () => {
    expect(isDbConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isDbConnectionError(Object.assign(new Error('x'), { code: '08006' }))).toBe(true);
    expect(isDbConnectionError(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isDbConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDbConnectionError(new Error('wrapped', { cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }) }))).toBe(true);
    expect(isDbConnectionError(new Error('unrelated'))).toBe(false);
    expect(isDbConnectionError('not an error')).toBe(false);
  });
});

describe('response schemas', () => {
  it('CommonErrorResponses covers the full superset', () => {
    expect(Object.keys(CommonErrorResponses).map(Number).sort((a, b) => a - b)).toEqual([...ALL_ERROR_STATUSES].sort((a, b) => a - b));
  });

  it('errorResponses selects a subset mapped to the error schema', () => {
    const r = errorResponses(400, 404);
    expect(Object.keys(r).map(Number).sort((a, b) => a - b)).toEqual([400, 404]);
    expect(r[400]).toBe(SCHEMA_ERROR_RESPONSE);
  });
});

describe('security-headers plugin', () => {
  afterEach(() => { delete process.env.PRODUCTION; delete process.env.NODE_ENV; });

  it('sets hardening headers on responses', async () => {
    const app = new Elysia().use(createSecurityHeadersPlugin({ production: false })).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-XSS-Protection')).toBe('0'); // legacy filter disabled
    expect(res.headers.get('Permissions-Policy')).toContain('geolocation=()');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBeNull(); // not production
  });

  it('emits HSTS in production', async () => {
    const app = new Elysia().use(createSecurityHeadersPlugin({ production: true })).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('emits HSTS when PRODUCTION=true without NODE_ENV', async () => {
    process.env.PRODUCTION = 'true';
    const app = new Elysia().use(createSecurityHeadersPlugin()).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('applies headers to error responses (thrown errors and 404s)', async () => {
    const app = new Elysia()
      .use(createSecurityHeadersPlugin({ production: false }))
      .get('/boom', () => { throw new Error('kaput'); });

    const errRes = await app.handle(new Request('http://localhost/boom'));
    expect(errRes.status).toBe(500);
    expect(errRes.headers.get('X-Frame-Options')).toBe('DENY');
    expect(errRes.headers.get('Content-Security-Policy')).toContain("default-src 'none'");

    const missing = await app.handle(new Request('http://localhost/nowhere'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('supports overriding / disabling the new headers', async () => {
    const app = new Elysia()
      .use(createSecurityHeadersPlugin({
        production: false,
        permissionsPolicy: 'camera=()',
        crossOriginOpenerPolicy: false,
        crossOriginResourcePolicy: 'cross-origin',
      }))
      .get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('Permissions-Policy')).toBe('camera=()');
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });
});

describe('client-ip plugin', () => {
  it('ignores X-Forwarded-For when the proxy is not trusted', async () => {
    const app = new Elysia().use(createClientIpPlugin([])).get('/', ({ clientIp }) => clientIp);
    const res = await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '9.9.9.9' } }));
    expect(await res.text()).not.toBe('9.9.9.9');
  });

  it('trusts X-Forwarded-For when trustAll is set', async () => {
    const app = new Elysia().use(createClientIpPlugin(['*'])).get('/', ({ clientIp }) => clientIp);
    const res = await app.handle(new Request('http://localhost/', { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }));
    expect(await res.text()).toBe('9.9.9.9');
  });
});

describe('normalizeIp', () => {
  it('normalizes IPv6-mapped IPv4 to dotted-quad and lowercases IPv6', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp(' 10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('returns null for non-IPs', () => {
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('10.0.0')).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });
});

describe('createClientIpResolver (rightmost-untrusted)', () => {
  it('ignores a spoofed leftmost entry: one trusted hop returns the real client', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    // Client sent a forged XFF ('1.2.3.4'); the trusted proxy appended the real
    // peer (203.0.113.7). Rightmost-untrusted must pick the appended entry.
    expect(resolve('10.0.0.1', '1.2.3.4, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('walks past a chain of two trusted proxies', () => {
    const resolve = createClientIpResolver(['10.0.0.1', '10.0.0.2']);
    // client → proxy2 → proxy1 (direct peer): XFF = client, proxy2
    expect(resolve('10.0.0.1', '198.51.100.9, 10.0.0.2')).toBe('198.51.100.9');
  });

  it('falls back to the direct peer on garbage XFF entries', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    expect(resolve('10.0.0.1', 'garbage-value')).toBe('10.0.0.1');
    expect(resolve('10.0.0.1', '203.0.113.7, <script>')).toBe('10.0.0.1');
  });

  it('normalizes an IPv6-mapped direct peer for the trusted check', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    // Peer address reported as ::ffff:10.0.0.1 must still count as trusted.
    expect(resolve('::ffff:10.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    // And IPv6-mapped candidates normalize to dotted-quad.
    expect(resolve('10.0.0.1', '::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('never honours XFF when the direct peer is untrusted', () => {
    const resolve = createClientIpResolver(['10.0.0.1']);
    expect(resolve('203.0.113.50', '1.2.3.4')).toBe('203.0.113.50');
  });

  it('returns the leftmost entry when the whole chain is trusted proxies', () => {
    const resolve = createClientIpResolver(['10.0.0.1', '10.0.0.2']);
    expect(resolve('10.0.0.1', '10.0.0.2')).toBe('10.0.0.2');
  });

  it('falls back to unknown when nothing is resolvable', () => {
    const resolve = createClientIpResolver([]);
    expect(resolve(undefined, '9.9.9.9')).toBe('unknown');
  });
});

describe('createErrorHandler', () => {
  const silentLogger: import('../logger/index.ts').Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger,
  };

  it('maps ApiError to its status + body', async () => {
    const app = new Elysia()
      .use(createErrorHandler(silentLogger, { production: false }))
      .get('/', () => { throw new NotFoundError('missing', 'thing_not_found'); });
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ key: 'thing_not_found', message: 'missing' });
  });

  it('maps DB connection errors to 503', async () => {
    const app = new Elysia()
      .use(createErrorHandler(silentLogger, { production: false }))
      .get('/', () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); });
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { key: string }).key).toBe('service_unavailable');
  });

  it('hides internal messages in production', async () => {
    const app = new Elysia()
      .use(createErrorHandler(silentLogger, { production: true }))
      .get('/', () => { throw new Error('secret internals'); });
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toBe('Internal Server Error');
  });

  it('redacts an unknown-key OctError (mapped to 500) in production, keeping the key', async () => {
    const app = new Elysia()
      .use(createErrorHandler(silentLogger, { production: true }))
      .get('/', () => { throw mapResultError({ key: 'weird_internal_thing', message: 'pg://user:pass@host exploded' }); });
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ key: 'weird_internal_thing', message: 'Internal error' });
  });

  it('keeps 4xx ApiError messages in production', async () => {
    const app = new Elysia()
      .use(createErrorHandler(silentLogger, { production: true }))
      .get('/', () => { throw mapResultError({ key: 'invalid_email', message: 'bad email' }); });
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ key: 'invalid_email', message: 'bad email' });
  });

  it('redacts via PRODUCTION=true env detection (no NODE_ENV)', async () => {
    process.env.PRODUCTION = 'true';
    try {
      const app = new Elysia()
        .use(createErrorHandler(silentLogger))
        .get('/', () => { throw new Error('secret internals'); });
      const res = await app.handle(new Request('http://localhost/'));
      expect(res.status).toBe(500);
      expect(((await res.json()) as { message: string }).message).toBe('Internal Server Error');
    } finally {
      delete process.env.PRODUCTION;
    }
  });

  it('validation schema accepts a generic error body', () => {
    expect(SCHEMA_ERROR_RESPONSE.safeParse({ key: 'x', message: 'y' }).success).toBe(true);
    const _z = z; // keep z import used
    expect(typeof _z).toBe('object');
  });
});

describe('config helpers', () => {
  const KEY = '__ELYSIA_CFG_TEST__';
  afterEach(() => { delete process.env[KEY]; delete process.env.PRODUCTION; delete process.env.NODE_ENV; });

  it('getEnv returns value, default, or throws', () => {
    process.env[KEY] = 'hi';
    expect(getEnv(KEY)).toBe('hi');
    expect(getEnv('__MISSING__', 'def')).toBe('def');
    expect(() => getEnv('__MISSING__')).toThrow(/Missing required/);
  });

  it('getEnvOptional / getEnvNumber / getEnvBoolean', () => {
    expect(getEnvOptional('__MISSING__')).toBeUndefined();
    process.env[KEY] = '42';
    expect(getEnvNumber(KEY, 7)).toBe(42);
    expect(getEnvNumber('__MISSING__', 7)).toBe(7);
    process.env[KEY] = 'TRUE';
    expect(getEnvBoolean(KEY, false)).toBe(true);
    process.env[KEY] = '1';
    expect(getEnvBoolean(KEY, false)).toBe(true);
    process.env[KEY] = 'no';
    expect(getEnvBoolean(KEY, true)).toBe(false);
  });

  it('getEnvNumber throws on garbage instead of returning NaN', () => {
    process.env[KEY] = 'not-a-number';
    expect(() => getEnvNumber(KEY, 7)).toThrow(/not a number/);
  });

  it('getEnvNumberOptional returns undefined on garbage or unset', () => {
    expect(getEnvNumberOptional('__MISSING__')).toBeUndefined();
    process.env[KEY] = 'not-a-number';
    expect(getEnvNumberOptional(KEY)).toBeUndefined();
    process.env[KEY] = '42';
    expect(getEnvNumberOptional(KEY)).toBe(42);
  });

  it('isProduction honors NODE_ENV and PRODUCTION', () => {
    expect(isProduction()).toBe(false);
    process.env.PRODUCTION = 'true';
    expect(isProduction()).toBe(true);
    delete process.env.PRODUCTION;
    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
  });

  it('parseCsv trims and drops empties; undefined → []', () => {
    expect(parseCsv('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv('')).toEqual([]);
  });

  it('parseCorsOrigins → list, or true when unset', () => {
    expect(parseCorsOrigins('https://a.com, https://b.com')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseCorsOrigins(undefined)).toBe(true);
  });
});
