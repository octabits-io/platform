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
 *
 * **The multipart upload is where the last TypeBox use in this repo went.** On
 * Elysia the body had to be `t.Object({ file: t.File() })` — zod could not
 * express the runtime `File` the body parser produced, so one route imported a
 * second schema language. Zod v4's `z.file()` plus the `'form'` validator
 * target covers it, and the app is now single-schema-language throughout.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponses, successResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { createWebResponse } from '@octabits-io/framework/storage/postgres';
import type { IoC } from '@octabits-io/framework/ioc';
import { errorJson } from '../http.ts';
import type { DemoServices } from '../container.ts';

const SCHEMA_FILE = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
  contentType: z.string(),
});

const TAGS = ['Files'];

export function createFileRoutes(container: IoC<DemoServices>) {
  const storage = () => container.resolve('storage');

  return new Hono()
    .post(
      '/',
      describeApiRoute({
        summary: 'Upload a file (multipart/form-data)',
        tags: TAGS,
        responses: { ...successResponses(201, SCHEMA_FILE), ...errorResponses(400, 429, 500) },
      }),
      octApiValidator('form', z.object({ file: z.file() })),
      async (c) => {
        const { file } = c.req.valid('form');
        const id = crypto.randomUUID();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const contentType = file.type || 'application/octet-stream';

        const uploaded = await storage().uploadObject({
          key: id,
          body: bytes,
          metadata: { 'content-type': contentType, name: file.name },
        });
        if (!uploaded.ok) return errorJson(c, uploaded.error);

        return c.json({ id, name: file.name, size: bytes.byteLength, contentType }, 201);
      },
    )
    .get(
      '/',
      describeApiRoute({
        summary: 'List uploaded files',
        tags: TAGS,
        responses: { 200: z.object({ items: z.array(SCHEMA_FILE) }), ...errorResponses(429, 500) },
      }),
      async (c) => {
        const result = await storage().listObjects({ includeHead: true });
        if (!result.ok) return errorJson(c, result.error);
        return c.json({
          items: result.value.objects.map((object) => ({
            id: object.key,
            name: object.metadata['name'] ?? object.key,
            size: object.size,
            contentType: object.contentType,
          })),
        });
      },
    )
    .get(
      '/:id',
      describeApiRoute({ summary: 'Download a file (ETag + 304 honored)', tags: TAGS }),
      octApiValidator('param', z.object({ id: z.string().min(1) })),
      // `createWebResponse` is framework-agnostic (Request headers in, Response
      // out) and needed no porting at all — the same call as the Elysia version.
      (c) =>
        createWebResponse(storage(), { key: c.req.valid('param').id }, c.req.raw.headers, {
          contentDisposition: 'attachment',
        }),
    );
}
