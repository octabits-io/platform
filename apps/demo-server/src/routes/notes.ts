/**
 * Note routes — thin wrappers over `createBaseCrudService`.
 *
 * Worth comparing against `contacts.ts`: the service came from a factory, so
 * these handlers are pure plumbing. `list` returns `Result<…, never>` (it cannot
 * fail as a value), and `create` returns `Result<void, …>` rather than the
 * created row — hence the extra `getById` to echo it back. Both are noted in the
 * README's paper-cut list.
 *
 * This module needs no per-request scope, so it is a plain `new Hono()` chain
 * rather than a `createRouteModule` — the factory exists to prove middleware is
 * mounted, and there is none to prove here.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponses, successResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import type { IoC } from '@octabits-io/framework/ioc';
import { errorJson } from '../http.ts';
import type { DemoServices } from '../container.ts';

const SCHEMA_NOTE = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const SCHEMA_CREATE_NOTE = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
});

const SCHEMA_ID_PARAM = z.object({ id: z.uuid() });

const TAGS = ['Notes'];

export function createNoteRoutes(container: IoC<DemoServices>) {
  const notes = () => container.resolve('notesService');

  return new Hono()
    .get(
      '/',
      describeApiRoute({
        summary: 'List notes',
        tags: TAGS,
        responses: {
          200: z.object({ items: z.array(SCHEMA_NOTE), total: z.number().int() }),
          ...errorResponses(400, 429, 500),
        },
      }),
      octApiValidator('query', z.object({
        page: z.coerce.number().int().positive().default(1),
        pageSize: z.coerce.number().int().positive().max(100).default(20),
      })),
      async (c) => {
        const query = c.req.valid('query');
        const result = await notes().list({ limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
        // `list` is typed `Result<_, never>` — it has no reachable failure
        // branch, but TS still won't narrow to the ok-side without the guard.
        if (!result.ok) return errorJson(c, result.error);
        return c.json({ items: result.value.items, total: result.value.total });
      },
    )
    .get(
      '/:id',
      describeApiRoute({
        summary: 'Get one note',
        tags: TAGS,
        responses: { 200: SCHEMA_NOTE, ...errorResponses(400, 404, 429, 500) },
      }),
      octApiValidator('param', SCHEMA_ID_PARAM),
      async (c) => {
        const result = await notes().getById({ id: c.req.valid('param').id });
        if (!result.ok) return errorJson(c, result.error);
        return c.json(result.value);
      },
    )
    .post(
      '/',
      describeApiRoute({
        summary: 'Create a note',
        tags: TAGS,
        responses: { ...successResponses(201, SCHEMA_NOTE), ...errorResponses(400, 404, 429, 500) },
      }),
      octApiValidator('json', SCHEMA_CREATE_NOTE),
      async (c) => {
        const id = crypto.randomUUID();
        const created = await notes().create({ id, ...c.req.valid('json') });
        if (!created.ok) return errorJson(c, created.error);
        // `create` resolves to void, so re-read the row to return it. Supplying
        // the id ourselves (instead of letting the column default fire) is what
        // makes that read possible.
        const result = await notes().getById({ id });
        if (!result.ok) return errorJson(c, result.error);
        return c.json(result.value, 201);
      },
    )
    .put(
      '/:id',
      describeApiRoute({
        summary: 'Update a note',
        tags: TAGS,
        responses: { 200: SCHEMA_NOTE, ...errorResponses(400, 404, 429, 500) },
      }),
      octApiValidator('param', SCHEMA_ID_PARAM),
      octApiValidator('json', SCHEMA_CREATE_NOTE.partial()),
      async (c) => {
        const { id } = c.req.valid('param');
        const updated = await notes().update({ id, ...c.req.valid('json') });
        if (!updated.ok) return errorJson(c, updated.error);
        const result = await notes().getById({ id });
        if (!result.ok) return errorJson(c, result.error);
        return c.json(result.value);
      },
    )
    .delete(
      '/:id',
      describeApiRoute({
        summary: 'Delete a note',
        tags: TAGS,
        responses: { ...successResponses(204, z.undefined()), ...errorResponses(400, 404, 429, 500) },
      }),
      octApiValidator('param', SCHEMA_ID_PARAM),
      async (c) => {
        const result = await notes().delete({ id: c.req.valid('param').id });
        if (!result.ok) return errorJson(c, result.error);
        return c.body(null, 204);
      },
    );
}
