/**
 * File routes — the `…/storage/postgres` blob provider plus its
 * framework-agnostic serve handler.
 *
 * Two things are worth copying from here:
 *   - **Content-type travels in `metadata`.** The provider reads
 *     `metadata['content-type']` to populate the stored `content_type` column;
 *     there is no dedicated parameter for it.
 *   - **`namespace` is omitted everywhere.** It is the provider's optional
 *     partition (a tenant id, an environment). A single-scope app addresses the
 *     root namespace by leaving it out — no sentinel value needed.
 *
 * `createWebResponse` is handed the raw request headers so it can answer 304 to
 * a conditional request, and `contentDisposition: 'attachment'` is set because
 * these blobs are untrusted uploads: serving user-supplied SVG/HTML inline from
 * the API's own origin is a stored-XSS vector.
 */
import { Elysia, t } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet, successResponses } from '@octabits-io/framework/elysia';
import { createWebResponse } from '@octabits-io/framework/storage/postgres';
import type { IoC } from '@octabits-io/framework/ioc';
import type { DemoServices } from '../container.ts';

const SCHEMA_FILE = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
  contentType: z.string(),
});

export function createFileRoutes(container: IoC<DemoServices>) {
  const storage = () => container.resolve('storage');

  return new Elysia({ prefix: '/files', tags: ['Files'] })
    .post(
      '/',
      async ({ body, set }) => {
        const id = crypto.randomUUID();
        const bytes = new Uint8Array(await body.file.arrayBuffer());
        const contentType = body.file.type || 'application/octet-stream';

        const uploaded = await storage().uploadObject({
          key: id,
          body: bytes,
          metadata: { 'content-type': contentType, name: body.file.name },
        });
        if (!uploaded.ok) return statusErrorWithSet(set, uploaded.error);

        set.status = 201;
        return { id, name: body.file.name, size: bytes.byteLength, contentType };
      },
      {
        // Multipart needs Elysia's own `t.File()` — a zod schema cannot express
        // the runtime File the body parser produces.
        body: t.Object({ file: t.File() }),
        response: { ...successResponses(201, SCHEMA_FILE), ...errorResponses(400, 429, 500) },
        detail: { summary: 'Upload a file (multipart/form-data)' },
      },
    )
    .get(
      '/',
      async ({ set }) => {
        const result = await storage().listObjects({ includeHead: true });
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return {
          items: result.value.objects.map((object) => ({
            id: object.key,
            name: object.metadata['name'] ?? object.key,
            size: object.size,
            contentType: object.contentType,
          })),
        };
      },
      {
        response: { 200: z.object({ items: z.array(SCHEMA_FILE) }), ...errorResponses(429, 500) },
        detail: { summary: 'List uploaded files' },
      },
    )
    .get(
      '/:id',
      ({ params, request }) =>
        createWebResponse(storage(), { key: params.id }, request.headers, {
          contentDisposition: 'attachment',
        }),
      {
        params: z.object({ id: z.string().min(1) }),
        detail: { summary: 'Download a file (ETag + 304 honored)' },
      },
    );
}
