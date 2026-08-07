/**
 * Error-mapping cores: key-convention → HTTP status, the `statusErrorWithSet`
 * route helper, the `ApiError` family, the pre-bound `createErrorMapper` trio,
 * and DB-connection detection.
 *
 * These are framework-neutral, so they are tested here rather than through a
 * glue module. (They previously lived in the deleted `src/elysia` suite —
 * moved with the code, unchanged.)
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getStatusCodeForError,
  statusErrorWithSet,
  mapResultError,
  createErrorMapper,
  isDbConnectionError,
  resolveErrorResponse,
  ApiError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  TooManyRequestsError,
} from './errors';

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

  it('maps conflict keys to 409', () => {
    expect(getStatusCodeForError({ key: 'already_running', message: '' })).toBe(409);
    expect(getStatusCodeForError({ key: 'already_published', message: '' })).toBe(409);
    expect(getStatusCodeForError({ key: 'listing_change_conflict', message: '' })).toBe(409);
    expect(getStatusCodeForError({ key: 'conflict', message: '' })).toBe(500); // bare key is not a convention
  });

  it('maps rate-limit keys to 429', () => {
    expect(getStatusCodeForError({ key: 'rate_limit_exceeded', message: '' })).toBe(429);
    expect(getStatusCodeForError({ key: 'ai_quota_rate_limited', message: '' })).toBe(429);
    expect(getStatusCodeForError({ key: 'rate_limit', message: '' })).toBe(500); // not a convention
  });

  it('maps *_invalid_status keys to 409', () => {
    expect(getStatusCodeForError({ key: 'booking_draft_invalid_status', message: '' })).toBe(409);
    expect(getStatusCodeForError({ key: 'invoice_invalid_status', message: '' })).toBe(409);
    expect(getStatusCodeForError({ key: 'invalid_status', message: '' })).toBe(400); // `invalid_*` prefix wins
  });

  it('keeps existing conventions unshadowed by the newer 409/429 rules', () => {
    // Each of these matches a new rule too — the earlier, more specific rule wins.
    expect(getStatusCodeForError({ key: 'invalid_state_conflict', message: '' })).toBe(400);
    expect(getStatusCodeForError({ key: 'validation_conflict', message: '' })).toBe(400);
    expect(getStatusCodeForError({ key: 'missing_field_conflict', message: '' })).toBe(422);
    expect(getStatusCodeForError({ key: 'incomplete_draft_conflict', message: '' })).toBe(422);
    expect(getStatusCodeForError({ key: 'already_deleted_not_found', message: '' })).toBe(404);
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

  it('covers the 409/429 conventions with their own subclasses', () => {
    const conflict = mapResultError({ key: 'already_running', message: 'm' });
    expect(conflict).toBeInstanceOf(ConflictError);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.key).toBe('already_running');

    const limited = mapResultError({ key: 'rate_limit_exceeded', message: 'm' });
    expect(limited).toBeInstanceOf(TooManyRequestsError);
    expect(limited.statusCode).toBe(429);
  });
});


describe('createErrorMapper', () => {
  const overrides = { attachment_blocked: 403, fill_already_running: 409 };
  const mapper = createErrorMapper(overrides);

  it('pre-binds the overrides into all three mappers', () => {
    expect(mapper.getStatusCodeForError({ key: 'attachment_blocked', message: 'm' })).toBe(403);
    expect(mapper.mapResultError({ key: 'attachment_blocked', message: 'm' })).toBeInstanceOf(ForbiddenError);

    const set: { status?: number | string } = {};
    expect(mapper.statusErrorWithSet(set, { key: 'attachment_blocked', message: 'nope' }))
      .toEqual({ key: 'attachment_blocked', message: 'nope' });
    expect(set.status).toBe(403);
  });

  it('still applies the generic conventions for unlisted keys', () => {
    expect(mapper.getStatusCodeForError({ key: 'listing_not_found', message: 'm' })).toBe(404);
    expect(mapper.getStatusCodeForError({ key: 'something_weird', message: 'm' })).toBe(500);
  });

  it('matches calling the unbound functions with the same overrides', () => {
    const error = { key: 'fill_already_running', message: 'm' };
    expect(mapper.getStatusCodeForError(error)).toBe(getStatusCodeForError(error, overrides));
  });

  it('binds no overrides when called without arguments', () => {
    const bare = createErrorMapper();
    expect(bare.getStatusCodeForError({ key: 'attachment_blocked', message: 'm' })).toBe(500);
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

describe('resolveErrorResponse', () => {
  const silentLogger: import('../logger/index.ts').Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger,
  };
  const resolve = (error: unknown, production: boolean) =>
    resolveErrorResponse(error, { production, logger: silentLogger });

  afterEach(() => {
    delete process.env.PRODUCTION;
    delete process.env.NODE_ENV;
  });

  it('redacts an unknown-key OctError (mapped to 500) in production, keeping the key', () => {
    const resolved = resolve(
      mapResultError({ key: 'weird_internal_thing', message: 'pg://user:pass@host exploded' }),
      true,
    );
    expect(resolved).toEqual({
      kind: 'body',
      status: 500,
      body: { key: 'weird_internal_thing', message: 'Internal error' },
    });
  });

  it('keeps 4xx messages in production', () => {
    const resolved = resolve(mapResultError({ key: 'invalid_email', message: 'bad email' }), true);
    expect(resolved).toEqual({
      kind: 'body',
      status: 400,
      body: { key: 'invalid_email', message: 'bad email' },
    });
  });

  it('hides internal messages of bare errors in production', () => {
    const resolved = resolve(new Error('secret internals'), true);
    expect(resolved).toMatchObject({ status: 500 });
    expect((resolved as { body: { message: string } }).body.message).toBe('Internal Server Error');
    // …and keeps them when not in production.
    expect(
      (resolve(new Error('secret internals'), false) as { body: { message: string } }).body.message,
    ).toBe('secret internals');
  });

  it('maps DB connection errors to 503', () => {
    const resolved = resolve(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }), false);
    expect(resolved).toMatchObject({ status: 503 });
    expect((resolved as { body: { key: string } }).body.key).toBe('service_unavailable');
  });

  it('logs 5xx but not 4xx (the redacted response is otherwise the only trace)', () => {
    const logged: string[] = [];
    const spyLogger: import('../logger/index.ts').Logger = {
      ...silentLogger,
      error: (message: string) => {
        logged.push(message);
      },
      child: () => spyLogger,
    };
    resolveErrorResponse(mapResultError({ key: 'weird_internal_thing', message: 'internals' }), {
      production: true,
      logger: spyLogger,
    });
    expect(logged).toEqual(['Domain error mapped to 500 (key: weird_internal_thing)']);

    resolveErrorResponse(mapResultError({ key: 'invalid_email', message: 'bad email' }), {
      production: true,
      logger: spyLogger,
    });
    expect(logged).toHaveLength(1); // 4xx is a client outcome, not logged here
  });

  it('passes a thrown Response through verbatim', () => {
    const response = new Response('teapot', { status: 418 });
    expect(resolve(response, true)).toEqual({ kind: 'response', response });
  });
});
