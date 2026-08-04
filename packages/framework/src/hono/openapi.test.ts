/**
 * OpenAPI adapter gate. The load-bearing test is the COMPOSITION one: upstream
 * issue #216 reports `paths: {}` from apps assembled exactly like ours (nested
 * `route()`, `basePath()`, middleware-wrapped sub-apps). The route-count
 * assertion also permanently guards the library's silent-omission mode (an
 * undescribed route just disappears from the spec). If an upgrade breaks
 * either, see `openapi.ts`'s header for the one-file fallback plan.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Logger } from '../logger/index.ts';
import { errorResponses, successResponses } from '../server/responses';
import { buildSwaggerOptions } from '../server/swagger';
import { createHonoApp } from './create-app';
import { describeApiRoute, mountOpenApi, octApiValidator } from './openapi';

const logger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => logger,
};

const SCHEMA_USER = z.object({ id: z.string(), name: z.string() });
const SCHEMA_USER_LIST = z.object({ items: z.array(SCHEMA_USER) });

function buildComposedApp() {
  const users = new Hono()
    .get(
      '/',
      describeApiRoute({ summary: 'List users', tags: ['Users'], responses: successResponses(200, SCHEMA_USER_LIST) }),
      octApiValidator('query', z.object({
        limit: z.coerce.number().int().max(100).optional(),
        sort: z.enum(['asc', 'desc']).optional(),
      })),
      (c) => c.json({ items: [] }),
    )
    .get(
      '/:id',
      describeApiRoute({ summary: 'Get user', tags: ['Users'], responses: { ...successResponses(200, SCHEMA_USER), ...errorResponses(404) } }),
      octApiValidator('param', z.object({ id: z.string() })),
      (c) => c.json({ id: c.req.valid('param').id, name: 'x' }),
    )
    .post(
      '/',
      describeApiRoute({ summary: 'Create user', tags: ['Users'], responses: successResponses(201, SCHEMA_USER) }),
      octApiValidator('json', z.object({ name: z.string().min(1) })),
      (c) => c.json({ id: 'new', name: c.req.valid('json').name }, 201),
    );

  const files = new Hono().post(
    '/upload',
    describeApiRoute({ summary: 'Upload', tags: ['Files'], responses: successResponses(200, z.object({ key: z.string() })) }),
    octApiValidator('form', z.object({ file: z.file() })),
    (c) => c.json({ key: 'k' }),
  );

  // Middleware-wrapped composition, two levels of route(), plus basePath —
  // the exact shape upstream #216 reports as producing an empty spec.
  const v1 = new Hono()
    .use(async (_c, next) => next())
    .route('/users', users)
    .route('/files', files);
  const routes = new Hono().basePath('/api').route('/v1', v1);

  const app = createHonoApp(routes, { logger });
  mountOpenApi(app, buildSwaggerOptions({ title: 'Gate API', version: '1.0.0' }));
  return app;
}

async function fetchSpec(app: Hono) {
  const res = await app.fetch(new Request('http://localhost/openapi.json'));
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    openapi: string;
    paths: Record<string, Record<string, { parameters?: Array<{ name: string; schema?: { enum?: string[] } }>; requestBody?: unknown; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
  }>;
}

describe('openapi gate (composed app — upstream #216)', () => {
  it('covers every described route with correct prefixes; no silent omissions', async () => {
    const spec = await fetchSpec(buildComposedApp() as never);

    expect(spec.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/files/upload',
      '/api/v1/users',
      '/api/v1/users/{id}',
    ]);

    // THE gate: path+method pairs == routes declared. A composition or
    // silent-omission regression fails here before any consumer sees it.
    const operations = Object.values(spec.paths).flatMap((methods) => Object.keys(methods));
    expect(operations.sort()).toEqual(['get', 'get', 'post', 'post']);
  });

  it('lifts request schemas into the spec (enum preserved) and renders response content', async () => {
    const spec = await fetchSpec(buildComposedApp() as never);

    const listParams = spec.paths['/api/v1/users']!.get!.parameters ?? [];
    const sort = listParams.find((p) => p.name === 'sort');
    expect(sort?.schema?.enum).toEqual(['asc', 'desc']);

    const ok = spec.paths['/api/v1/users']!.get!.responses?.['200'];
    expect(ok?.content?.['application/json']?.schema).toBeTruthy();

    expect(spec.paths['/api/v1/files/upload']!.post!.requestBody).toBeTruthy();
  });

  it('validation failures still produce the standard validation_error body', async () => {
    const app = buildComposedApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/users?limit=200'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { key: string; fields: Array<{ path: string }> };
    expect(body.key).toBe('validation_error');
    expect(body.fields.some((f) => f.path.includes('limit'))).toBe(true);
  });

  it('octApiValidator types c.req.valid() and passes valid requests through', async () => {
    const app = buildComposedApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'new', name: 'Ada' });
  });
});
