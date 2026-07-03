import { describe, it, expect, afterEach } from 'vitest';
import { Elysia } from 'elysia';
import { z } from 'zod';
import { createSecurityHeadersPlugin } from './security-headers';
import { createClientIpPlugin } from './client-ip';
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
  it('sets hardening headers on responses', async () => {
    const app = new Elysia().use(createSecurityHeadersPlugin({ production: false })).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Strict-Transport-Security')).toBeNull(); // not production
  });

  it('emits HSTS in production', async () => {
    const app = new Elysia().use(createSecurityHeadersPlugin({ production: true })).get('/', () => 'ok');
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
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

describe('createErrorHandler', () => {
  const silentLogger = { error: () => {} };

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
