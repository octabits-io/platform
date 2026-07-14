/**
 * Note routes — thin wrappers over `createBaseCrudService`.
 *
 * Worth comparing against `contacts.ts`: the service came from a factory, so
 * these handlers are pure plumbing. `list` returns `Result<…, never>` (it cannot
 * fail as a value), and `create` returns `Result<void, …>` rather than the
 * created row — hence the extra `getById` to echo it back. Both are noted in the
 * README's paper-cut list.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet, successResponses } from '@octabits-io/framework/elysia';
import type { IoC } from '@octabits-io/framework/ioc';
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

export function createNoteRoutes(container: IoC<DemoServices>) {
  const notes = () => container.resolve('notesService');

  return new Elysia({ prefix: '/notes', tags: ['Notes'] })
    .get(
      '/',
      async ({ query, set }) => {
        const result = await notes().list({ limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
        // `list` is typed `Result<_, never>` — it has no reachable failure
        // branch, but TS still won't narrow to the ok-side without the guard.
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return { items: result.value.items, total: result.value.total };
      },
      {
        query: z.object({
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(100).default(20),
        }),
        response: {
          200: z.object({ items: z.array(SCHEMA_NOTE), total: z.number().int() }),
          ...errorResponses(400, 429, 500),
        },
        detail: { summary: 'List notes' },
      },
    )
    .get(
      '/:id',
      async ({ params, set }) => {
        const result = await notes().getById({ id: params.id });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: { 200: SCHEMA_NOTE, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Get one note' },
      },
    )
    .post(
      '/',
      async ({ body, set }) => {
        const id = crypto.randomUUID();
        const created = await notes().create({ id, ...body });
        if (!created.ok) return statusErrorWithSet(set, created.error);
        // `create` resolves to void, so re-read the row to return it. Supplying
        // the id ourselves (instead of letting the column default fire) is what
        // makes that read possible.
        const result = await notes().getById({ id });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        set.status = 201;
        return result.value;
      },
      {
        body: SCHEMA_CREATE_NOTE,
        response: { ...successResponses(201, SCHEMA_NOTE), ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Create a note' },
      },
    )
    .put(
      '/:id',
      async ({ params, body, set }) => {
        const updated = await notes().update({ id: params.id, ...body });
        if (!updated.ok) return statusErrorWithSet(set, updated.error);
        const result = await notes().getById({ id: params.id });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        params: z.object({ id: z.uuid() }),
        body: SCHEMA_CREATE_NOTE.partial(),
        response: { 200: SCHEMA_NOTE, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Update a note' },
      },
    )
    .delete(
      '/:id',
      async ({ params, set }) => {
        const result = await notes().delete({ id: params.id });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        set.status = 204;
        return undefined;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: { ...successResponses(204, z.undefined()), ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Delete a note' },
      },
    );
}
