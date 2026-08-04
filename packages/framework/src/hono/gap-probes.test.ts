/**
 * SPIKE (elysia-exit-option): gap probe #7 — the `t.File()` multipart one-off.
 *
 * The demo-server's `files.ts` needs Elysia's `t.File()` because a zod schema
 * cannot express the runtime `File` Elysia's body parser produces. On Hono the
 * gap disappears: `c.req.parseBody()` yields real `File` instances and zod v4
 * has a first-class `z.file()` (with `.min`/`.max`/`.mime`) to validate them —
 * no TypeBox escape hatch, one schema language end to end.
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
