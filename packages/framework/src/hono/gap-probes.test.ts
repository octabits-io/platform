/**
 * Multipart file upload — the one route shape that used to need a TypeBox
 * escape hatch (`t.File()`), because a zod schema could not express the runtime
 * `File` Elysia's body parser produced. On Hono there is no gap:
 * `c.req.parseBody()` yields real `File` instances and zod v4 has a first-class
 * `z.file()` (with `.min`/`.max`/`.mime`) to validate them — one schema
 * language end to end. Pinned so a regression would be caught here, not in a
 * consumer's upload route.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

const SCHEMA_UPLOAD = z.object({
  file: z.file().max(1024 * 1024),
  label: z.string().min(1),
});

describe('multipart upload via parseBody + z.file() (gap probe #7)', () => {
  function build() {
    return new Hono().post('/files', async (c) => {
      const parsed = SCHEMA_UPLOAD.safeParse(await c.req.parseBody());
      if (!parsed.success) return c.json({ key: 'validation_error', message: 'Validation failed' }, 400);
      const bytes = new Uint8Array(await parsed.data.file.arrayBuffer());
      return c.json({
        name: parsed.data.file.name,
        size: bytes.byteLength,
        contentType: parsed.data.file.type,
        label: parsed.data.label,
      }, 201);
    });
  }

  it('accepts a multipart file and reads name/type/bytes', async () => {
    const form = new FormData();
    form.append('file', new File(['hello world'], 'greeting.txt', { type: 'text/plain' }));
    form.append('label', 'docs');

    const res = await build().request('/files', { method: 'POST', body: form });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      name: 'greeting.txt', size: 11, contentType: 'text/plain', label: 'docs',
    });
  });

  it('rejects a missing file via plain zod', async () => {
    const form = new FormData();
    form.append('label', 'docs');

    const res = await build().request('/files', { method: 'POST', body: form });

    expect(res.status).toBe(400);
  });
});
