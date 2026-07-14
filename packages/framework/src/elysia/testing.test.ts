import { describe, it, expect } from 'vitest';
import { Elysia } from 'elysia';
import { testRequest, testAuthenticatedRequest, decodeResponseBody } from './testing';

const app = new Elysia()
  .get('/json', () => ({ items: [1, 2] }))
  .get('/text', ({ set }) => { set.headers['content-type'] = 'text/plain'; return 'plain body'; })
  .get('/pdf', ({ set }) => {
    set.headers['content-type'] = 'application/pdf';
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
  })
  .get('/no-content', () => new Response(null, { status: 204 }))
  .get('/redirect', () => new Response(null, { status: 302, headers: { location: '/json' } }))
  .get('/echo-query', ({ query }) => ({ query }))
  .get('/echo-headers', ({ request }) => ({
    contentType: request.headers.get('content-type'),
    authorization: request.headers.get('authorization'),
  }))
  .post('/echo-body', ({ body }) => ({ received: body }));

describe('testRequest', () => {
  it('returns status, decoded JSON data, and headers', async () => {
    const res = await testRequest(app, 'GET', '/json');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ items: [1, 2] });
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('JSON-serializes the body and sends application/json by default', async () => {
    const res = await testRequest(app, 'POST', '/echo-body', { body: { name: 'x' } });

    expect(res.data).toEqual({ received: { name: 'x' } });
  });

  it('appends query params, dropping undefined values', async () => {
    const res = await testRequest(app, 'GET', '/echo-query', {
      query: { limit: 10, active: true, cursor: undefined, name: 'a b' },
    });

    expect(res.data).toEqual({ query: { limit: '10', active: 'true', name: 'a b' } });
  });

  it('sends token as a Bearer authorization header', async () => {
    const res = await testRequest(app, 'GET', '/echo-headers', { token: 'abc123' });

    expect(res.data).toMatchObject({ authorization: 'Bearer abc123' });
  });

  it('lets an explicit authorization header win over token', async () => {
    const res = await testRequest(app, 'GET', '/echo-headers', {
      token: 'abc123',
      headers: { Authorization: 'Basic xyz' },
    });

    expect(res.data).toMatchObject({ authorization: 'Basic xyz' });
  });

  it('replaces (not appends) the default content-type regardless of header casing', async () => {
    const res = await testRequest(app, 'GET', '/echo-headers', {
      headers: { 'content-type': 'text/plain' },
    });

    // A plain-record merge would have produced "application/json, text/plain".
    expect(res.data).toMatchObject({ contentType: 'text/plain' });
  });

  it('decodes non-JSON content types as text', async () => {
    const res = await testRequest(app, 'GET', '/text');

    expect(res.data).toBe('plain body');
  });

  it('decodes binary content types to a byte-exact Buffer', async () => {
    const res = await testRequest(app, 'GET', '/pdf');

    expect(Buffer.isBuffer(res.data)).toBe(true);
    expect(res.data).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
  });

  it('skips body decoding on 204 and redirects, keeping headers readable', async () => {
    const noContent = await testRequest(app, 'GET', '/no-content');
    expect(noContent.status).toBe(204);
    expect(noContent.data).toBeNull();

    const redirect = await testRequest(app, 'GET', '/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.data).toBeNull();
    expect(redirect.headers.get('location')).toBe('/json');
  });

  it('honors a custom decodeBody', async () => {
    const res = await testRequest(app, 'GET', '/json', {
      decodeBody: async (r) => `raw:${await r.text()}`,
    });

    expect(res.data).toBe('raw:{"items":[1,2]}');
  });
});

describe('testAuthenticatedRequest', () => {
  it('sends the full authHeader value verbatim', async () => {
    const res = await testAuthenticatedRequest(app, 'GET', '/echo-headers', {}, 'Bearer test-token');

    expect(res.data).toMatchObject({ authorization: 'Bearer test-token' });
  });

  it('preserves other options while adding the auth header', async () => {
    const res = await testAuthenticatedRequest(app, 'POST', '/echo-body', { body: { a: 1 } }, 'Bearer t');

    expect(res.data).toEqual({ received: { a: 1 } });
  });
});

describe('decodeResponseBody', () => {
  it('is reusable directly by a custom decoder', async () => {
    const res = await testRequest(app, 'GET', '/json', {
      decodeBody: async (r) => ({ wrapped: await decodeResponseBody(r) }),
    });

    expect(res.data).toEqual({ wrapped: { items: [1, 2] } });
  });
});
