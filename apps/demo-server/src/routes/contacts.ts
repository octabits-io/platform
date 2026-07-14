/**
 * Contact routes.
 *
 * Every handler follows the same shape: call a service, and on a failed
 * `Result` hand the error to `statusErrorWithSet`. That helper maps the error
 * `key` to a status by convention (`contact_not_found` → 404 because it ends in
 * `_not_found`) and whitelists the response body to `{ key, message }` — so a
 * service error can never leak fields it didn't mean to expose, and 5xx messages
 * are redacted in production.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet, successResponses } from '@octabits-io/framework/elysia';
import type { DemoScopePlugin } from '../request-scope.ts';
import { hasPermission } from '../rbac.ts';
import { welcomeEmailQueue } from '../queues/welcome-email.ts';

const SCHEMA_CONTACT = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const SCHEMA_CONTACT_LIST = z.object({
  items: z.array(SCHEMA_CONTACT),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

const SCHEMA_CREATE_CONTACT = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
});

const SCHEMA_UPDATE_CONTACT = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
});

/**
 * Routes resolve their services through `ctx.scope` — the per-request child
 * container mounted by the scope plugin (see `../request-scope.ts`). Root
 * singletons (`contactsService`, `idempotency`, `boss`) resolve through the
 * scope's parent chain; request-seeded values (`role`) resolve from the scope
 * itself. Mounting the plugin here (deduplicated by name) is what types
 * `ctx.scope` on every handler.
 */
export function createContactRoutes(scopePlugin: DemoScopePlugin) {
  return new Elysia({ prefix: '/contacts', tags: ['Contacts'] })
    .use(scopePlugin)
    .get(
      '/',
      async ({ query, set, scope }) => {
        const result = await scope.resolve('contactsService').list({ page: query.page, pageSize: query.pageSize });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        query: z.object({
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().positive().max(100).default(20),
        }),
        response: { 200: SCHEMA_CONTACT_LIST, ...errorResponses(400, 429, 500) },
        detail: { summary: 'List contacts (paginated, emails decrypted)' },
      },
    )
    // Declared before `/:id` so `search` is not swallowed by the id pattern.
    .get(
      '/search',
      async ({ query, set, scope }) => {
        const result = await scope.resolve('contactsService').searchByEmail(query.email);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return { items: result.value };
      },
      {
        query: z.object({ email: z.string().min(1) }),
        response: { 200: z.object({ items: z.array(SCHEMA_CONTACT) }), ...errorResponses(400, 429, 500) },
        detail: { summary: 'Exact-match contact lookup by email (via the blind index)' },
      },
    )
    .get(
      '/:id',
      async ({ params, set, scope }) => {
        const result = await scope.resolve('contactsService').getById(params.id);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: { 200: SCHEMA_CONTACT, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Get one contact' },
      },
    )
    .post(
      '/',
      async ({ body, set, scope }) => {
        const result = await scope.resolve('contactsService').create(body);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        set.status = 201;
        return result.value;
      },
      {
        body: SCHEMA_CREATE_CONTACT,
        // `successResponses` adds a 200 alias next to the 201 — without it,
        // Elysia infers an extra 200 entry from the handler's return union
        // (error body included) and Eden folds that union into `data`.
        response: { ...successResponses(201, SCHEMA_CONTACT), ...errorResponses(400, 429, 500) },
        detail: { summary: 'Create a contact (email encrypted + blind-indexed)' },
      },
    )
    .put(
      '/:id',
      async ({ params, body, set, scope }) => {
        const result = await scope.resolve('contactsService').update(params.id, body);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        params: z.object({ id: z.uuid() }),
        body: SCHEMA_UPDATE_CONTACT,
        response: { 200: SCHEMA_CONTACT, ...errorResponses(400, 404, 429, 500) },
        detail: { summary: 'Update a contact' },
      },
    )
    .delete(
      '/:id',
      async ({ params, set, scope }) => {
        // The one RBAC-guarded route: `viewer` may read contacts but not delete
        // one. The role is request-scoped state seeded from the `x-demo-role`
        // header. `forbidden` → 403 by the elysia error module's key conventions.
        if (!hasPermission(scope.resolve('role'), { contact: ['delete'] })) {
          return statusErrorWithSet(set, {
            key: 'forbidden',
            message: 'Role is not permitted to delete contacts',
          });
        }
        const result = await scope.resolve('contactsService').remove(params.id);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        set.status = 204;
        return undefined;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: { ...successResponses(204, z.undefined()), ...errorResponses(400, 403, 404, 429, 500) },
        detail: { summary: 'Delete a contact (requires the admin demo role)' },
      },
    )
    .post(
      '/:id/welcome',
      async ({ params, set, scope }) => {
        // Idempotency (`…/drizzle/idempotency`) keeps a double-submit from
        // queueing two welcome mails: `begin()` classifies the request as
        // cached / fresh / conflict, and only a `fresh` outcome enqueues.
        // `requestHash` is what makes "same key, different request" a conflict
        // rather than a silent replay.
        const idempotency = scope.resolve('idempotency');
        const outcome = await idempotency.begin({
          key: `welcome:${params.id}`,
          requestHash: params.id,
        });

        if (outcome.kind === 'cached') {
          set.status = outcome.cached.status;
          // The stored body is replayed verbatim; `replayed` is stamped here so
          // the caller can tell a replay from the original enqueue.
          const cached = outcome.cached.body as { jobId: string; queue: string };
          return { ...cached, replayed: true };
        }
        if (outcome.kind === 'conflict') {
          return statusErrorWithSet(set, {
            key: 'invalid_idempotent_replay',
            message: 'This idempotency key was used with a different request',
          });
        }

        const contact = await scope.resolve('contactsService').getById(params.id);
        if (!contact.ok) return statusErrorWithSet(set, contact.error);

        const { enqueue } = welcomeEmailQueue.createEnqueuer({ boss: scope.resolve('boss').getBoss() });
        const queued = await enqueue({ contactId: params.id });
        if (!queued.ok) return statusErrorWithSet(set, queued.error);

        const body = { jobId: queued.value.jobId, queue: queued.value.queue, replayed: false };
        // Only successful responses are committed — a failed enqueue must be
        // retryable, so we commit after the enqueue succeeds, never before.
        await outcome.commit(202, body);
        set.status = 202;
        return body;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: {
          ...successResponses(202, z.object({ jobId: z.string(), queue: z.string(), replayed: z.boolean() })),
          ...errorResponses(400, 404, 429, 500),
        },
        detail: { summary: 'Queue a welcome email (idempotent per contact)' },
      },
    );
}
