/**
 * `errorJson` / `createErrorJson` — the return-based half of the Hono glue.
 *
 * The status conventions themselves live in `../server`'s `createErrorMapper`
 * and are tested there; what is only true HERE is the Hono binding: the body
 * reaches `c.json` with the mapped status attached, and the returned shape
 * stays a `TypedResponse` so the error body survives into the route type an
 * `hc` client reads. (`registerErrorHandler` covers the thrown path; this is
 * the one routes are supposed to prefer.)
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createErrorJson, errorJson } from './errors.ts';

describe('errorJson', () => {
  const app = new Hono()
    .get('/not-found', (c) => errorJson(c, { key: 'note_not_found', message: 'Note 7 not found' }))
    .get('/conflict', (c) => errorJson(c, { key: 'already_exists', message: 'Taken' }))
    .get('/rate', (c) => errorJson(c, { key: 'rate_limit_exceeded', message: 'Slow down' }))
    .get('/unknown', (c) => errorJson(c, { key: 'something_odd', message: 'Boom' }));

  it('maps a *_not_found key to 404 with a { key, message } body', async () => {
    const res = await app.request('/not-found');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ key: 'note_not_found', message: 'Note 7 not found' });
  });

  it('maps the conflict and rate-limit conventions', async () => {
    expect((await app.request('/conflict')).status).toBe(409);
    expect((await app.request('/rate')).status).toBe(429);
  });

  it('falls back to 500 for an unrecognised key', async () => {
    const res = await app.request('/unknown');

    expect(res.status).toBe(500);
  });
});

describe('createErrorJson', () => {
  it('pre-binds domain overrides, leaving the conventions intact', async () => {
    // The reason the factory exists: one place per app decides that
    // `ai_quota_exceeded` is a 429, and every route inherits it.
    const domainErrorJson = createErrorJson({ ai_quota_exceeded: 429 });
    const app = new Hono()
      .get('/quota', (c) => domainErrorJson(c, { key: 'ai_quota_exceeded', message: 'No credits' }))
      .get('/not-found', (c) => domainErrorJson(c, { key: 'note_not_found', message: 'gone' }));

    expect((await app.request('/quota')).status).toBe(429);
    expect((await app.request('/not-found')).status).toBe(404);
  });

  it('keeps the unbound export free of another app’s overrides', async () => {
    createErrorJson({ ai_quota_exceeded: 429 });
    const app = new Hono().get('/quota', (c) =>
      errorJson(c, { key: 'ai_quota_exceeded', message: 'No credits' }),
    );

    // A shared mutable mapper would have leaked the 429 into every consumer.
    expect((await app.request('/quota')).status).toBe(500);
  });
});
