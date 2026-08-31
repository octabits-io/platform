/**
 * Contact routes.
 *
 * Every handler follows the same shape: call a service, and on a failed
 * `Result` hand the error to `errorJson` (`../http.ts`). That helper maps the
 * error `key` to a status by convention (`contact_not_found` → 404 because it
 * ends in `_not_found`) and whitelists the response body to `{ key, message }`
 * — so a service error can never leak fields it didn't mean to expose, and 5xx
 * messages are redacted in production.
 *
 * Three Hono-shaped changes from the Elysia original are worth copying:
 *
 * - Route schemas moved out of the trailing options object into
 *   `octApiValidator(target, schema)` arguments, read back with
 *   `c.req.valid(target)`. One declaration now serves runtime validation, the
 *   handler's types, the OpenAPI request parameters, AND the standard
 *   `validation_error` body.
 * - `detail` + `response` became one `describeApiRoute({ summary, tags,
 *   responses })` middleware, which takes the existing
 *   `successResponses`/`errorResponses` zod maps verbatim.
 * - `set.status = n; return body` became `return c.json(body, n)`.
 */
import { z } from 'zod';
import { errorResponses, successResponses } from '@octabits-io/framework/server';
import { createRouteModule } from '@octabits-io/framework/hono';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { errorJson } from '../http.ts';
import type { DemoScopeMiddleware } from '../request-scope.ts';
import { hasPermission } from '../rbac.ts';
import { welcomeEmailQueue } from '../queues/welcome-email.ts';

/**
 * ISO `YYYY-MM-DD`, or `''` for "not set" — the kit's `Period` vocabulary,
 * carried verbatim so the SPA can bind a response field straight into
 * `FlexiblePeriodInput` without a null dance. `z.iso.date()` alone would
 * reject the empty string.
 */
const SCHEMA_WISH_DATE = z.union([z.iso.date(), z.literal('')]);

const SCHEMA_CONTACT = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  wishStart: SCHEMA_WISH_DATE,
  wishEnd: SCHEMA_WISH_DATE,
  wishNights: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const SCHEMA_CONTACT_LIST = z.object({
  items: z.array(SCHEMA_CONTACT),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

/** The wish is optional on every write, and independently clearable. */
const SCHEMA_WISH_INPUT = z.object({
  wishStart: SCHEMA_WISH_DATE.optional(),
  wishEnd: SCHEMA_WISH_DATE.optional(),
  wishNights: z.number().int().min(1).max(365).nullable().optional(),
});

const SCHEMA_CREATE_CONTACT = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
  ...SCHEMA_WISH_INPUT.shape,
});

const SCHEMA_UPDATE_CONTACT = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
  ...SCHEMA_WISH_INPUT.shape,
});

const SCHEMA_ID_PARAM = z.object({ id: z.uuid() });

const SCHEMA_PAGE_QUERY = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const TAGS = ['Contacts'];

/**
 * Routes resolve their services through `c.get('scope')` — the per-request
 * child container the scope middleware seeds (see `../request-scope.ts`). Root
 * singletons (`contactsService`, `idempotency`, `boss`) resolve through the
 * scope's parent chain; request-seeded values (`role`) resolve from the scope
 * itself.
 *
 * `createRouteModule` is what makes that typed *and* true: the builder app is
 * only reachable by handing the middleware over first, so this module cannot
 * declare `c.get('scope')` without mounting what supplies it. The build
 * callback must return the CHAIN — Hono accumulates route types through it,
 * and that accumulated type is what `hc` reads.
 */
export function createContactRoutes(scopeMiddleware: DemoScopeMiddleware) {
  return createRouteModule({ middleware: [scopeMiddleware] }, (app) =>
    app
      .get(
        '/',
        describeApiRoute({
          summary: 'List contacts (paginated, emails decrypted)',
          tags: TAGS,
          responses: { 200: SCHEMA_CONTACT_LIST, ...errorResponses(400, 429, 500) },
        }),
        octApiValidator('query', SCHEMA_PAGE_QUERY),
        async (c) => {
          const query = c.req.valid('query');
          const result = await c
            .get('scope')
            .resolve('contactsService')
            .list({ page: query.page, pageSize: query.pageSize });
          if (!result.ok) return errorJson(c, result.error);
          return c.json(result.value);
        },
      )
      // Declared before `/:id` so `search` is not swallowed by the id pattern.
      .get(
        '/search',
        describeApiRoute({
          summary: 'Exact-match contact lookup by email (via the blind index)',
          tags: TAGS,
          responses: { 200: z.object({ items: z.array(SCHEMA_CONTACT) }), ...errorResponses(400, 429, 500) },
        }),
        octApiValidator('query', z.object({ email: z.string().min(1) })),
        async (c) => {
          const result = await c.get('scope').resolve('contactsService').searchByEmail(c.req.valid('query').email);
          if (!result.ok) return errorJson(c, result.error);
          return c.json({ items: result.value });
        },
      )
      .get(
        '/:id',
        describeApiRoute({
          summary: 'Get one contact',
          tags: TAGS,
          responses: { 200: SCHEMA_CONTACT, ...errorResponses(400, 404, 429, 500) },
        }),
        octApiValidator('param', SCHEMA_ID_PARAM),
        async (c) => {
          const result = await c.get('scope').resolve('contactsService').getById(c.req.valid('param').id);
          if (!result.ok) return errorJson(c, result.error);
          return c.json(result.value);
        },
      )
      .post(
        '/',
        describeApiRoute({
          summary: 'Create a contact (email encrypted + blind-indexed)',
          tags: TAGS,
          // `successResponses` still declares the 200 alias next to the 201.
          // Hono infers no phantom 200 from the handler's return union the way
          // Elysia did, so this is now documentation-only — kept so the two
          // glue modules' route files stay one search-and-replace apart.
          responses: { ...successResponses(201, SCHEMA_CONTACT), ...errorResponses(400, 429, 500) },
        }),
        octApiValidator('json', SCHEMA_CREATE_CONTACT),
        async (c) => {
          const result = await c.get('scope').resolve('contactsService').create(c.req.valid('json'));
          if (!result.ok) return errorJson(c, result.error);
          return c.json(result.value, 201);
        },
      )
      .put(
        '/:id',
        describeApiRoute({
          summary: 'Update a contact',
          tags: TAGS,
          responses: { 200: SCHEMA_CONTACT, ...errorResponses(400, 404, 429, 500) },
        }),
        octApiValidator('param', SCHEMA_ID_PARAM),
        octApiValidator('json', SCHEMA_UPDATE_CONTACT),
        async (c) => {
          const result = await c
            .get('scope')
            .resolve('contactsService')
            .update(c.req.valid('param').id, c.req.valid('json'));
          if (!result.ok) return errorJson(c, result.error);
          return c.json(result.value);
        },
      )
      .delete(
        '/:id',
        describeApiRoute({
          summary: 'Delete a contact (requires the admin demo role)',
          tags: TAGS,
          responses: { ...successResponses(204, z.undefined()), ...errorResponses(400, 403, 404, 429, 500) },
        }),
        octApiValidator('param', SCHEMA_ID_PARAM),
        async (c) => {
          // The one RBAC-guarded route: `viewer` may read contacts but not
          // delete one. The role is request-scoped state seeded from the
          // `x-demo-role` header. `forbidden` → 403 by the key conventions.
          const scope = c.get('scope');
          if (!hasPermission(scope.resolve('role'), { contact: ['delete'] })) {
            return errorJson(c, { key: 'forbidden', message: 'Role is not permitted to delete contacts' });
          }
          const result = await scope.resolve('contactsService').remove(c.req.valid('param').id);
          if (!result.ok) return errorJson(c, result.error);
          // Hono wants an explicit empty body for 204 — `return undefined` is
          // not a response here (and the Elysia version's node/bun 204 split
          // stops being a hazard at all).
          return c.body(null, 204);
        },
      )
      .post(
        '/:id/welcome',
        describeApiRoute({
          summary: 'Queue a welcome email (idempotent per contact)',
          tags: TAGS,
          responses: {
            ...successResponses(202, z.object({ jobId: z.string(), queue: z.string(), replayed: z.boolean() })),
            ...errorResponses(400, 404, 429, 500),
          },
        }),
        octApiValidator('param', SCHEMA_ID_PARAM),
        async (c) => {
          const { id } = c.req.valid('param');
          const scope = c.get('scope');
          // Idempotency (`…/drizzle/idempotency`) keeps a double-submit from
          // queueing two welcome mails: `begin()` classifies the request as
          // cached / fresh / conflict, and only a `fresh` outcome enqueues.
          // `requestHash` is what makes "same key, different request" a
          // conflict rather than a silent replay.
          const idempotency = scope.resolve('idempotency');
          const outcome = await idempotency.begin({ key: `welcome:${id}`, requestHash: id });

          if (outcome.kind === 'cached') {
            // The stored body is replayed verbatim; `replayed` is stamped here
            // so the caller can tell a replay from the original enqueue.
            const cached = outcome.cached.body as { jobId: string; queue: string };
            return c.json({ ...cached, replayed: true }, 202);
          }
          if (outcome.kind === 'conflict') {
            return errorJson(c, {
              key: 'invalid_idempotent_replay',
              message: 'This idempotency key was used with a different request',
            });
          }

          const contact = await scope.resolve('contactsService').getById(id);
          if (!contact.ok) return errorJson(c, contact.error);

          const { enqueue } = welcomeEmailQueue.createEnqueuer({ boss: scope.resolve('boss').getBoss() });
          const queued = await enqueue({ contactId: id });
          if (!queued.ok) return errorJson(c, queued.error);

          const body = { jobId: queued.value.jobId, queue: queued.value.queue, replayed: false };
          // Only successful responses are committed — a failed enqueue must be
          // retryable, so we commit after the enqueue succeeds, never before.
          await outcome.commit(202, body);
          return c.json(body, 202);
        },
      ),
  );
}
