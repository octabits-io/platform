/**
 * SPIKE (elysia-exit-option): chain-length probe — the TS2589 failure class.
 *
 * reynt's Eden pain is not aggregate check time but instantiation-DEPTH
 * explosions on long route chains (the operations route group sits at the
 * TS2589 ceiling). This probe chains N routes on a single instance (schemas
 * on every route) and type-checks a client call against the LAST route,
 * for Elysia+treaty and Hono+hc, at increasing N.
 *
 * Run: node chain-probe.mjs [tscPath]   (defaults to the workspace tsc)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'chain-out');
const TSC = process.argv[2] ?? join(ROOT, '../../node_modules/.bin/tsc');

const SIZES = [30, 60, 120, 200, 300];

const SCHEMAS = `
const SCHEMA_ITEM = z.object({
  id: z.string(), name: z.string().min(1).max(255), price: z.number().min(0),
  active: z.boolean(), tags: z.array(z.string()),
});
const SCHEMA_QUERY = z.object({ page: z.coerce.number().int().optional(), search: z.string().optional() });
const SCHEMA_ERROR = z.object({ key: z.string(), message: z.string() });
const STUB = { id: 'x', name: 'x', price: 1, active: true, tags: [] as string[] };
`;

function elysiaApp(n) {
  const routes = Array.from({ length: n }, (_, i) => `  .get('/r${i}', ({ query }) => ({ items: [STUB], total: 1 }), { query: SCHEMA_QUERY, response: { 200: z.object({ items: z.array(SCHEMA_ITEM), total: z.number() }), 401: SCHEMA_ERROR } })`).join('\n');
  return `import { Elysia } from 'elysia';
import { z } from 'zod';
${SCHEMAS}
export const app = new Elysia({ prefix: '/api' })
${routes};
export type App = typeof app;
`;
}

function elysiaUsage(n) {
  return `import { treaty } from '@elysiajs/eden';
import type { App } from './app';
const client = treaty<App>('http://localhost');
export async function probe() {
  const { data, error } = await client.api.r${n - 1}.get({ query: { page: 1 } });
  if (error) return null;
  return data.items.map((item) => item.name);
}
`;
}

function honoApp(n) {
  const routes = Array.from({ length: n }, (_, i) => `  .get('/r${i}', zValidator('query', SCHEMA_QUERY), (c) => c.json({ items: [STUB], total: 1 }, 200))`).join('\n');
  return `import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
${SCHEMAS}
export const app = new Hono().basePath('/api')
${routes};
export type App = typeof app;
`;
}

function honoUsage(n) {
  return `import { hc } from 'hono/client';
import type { App } from './app';
const client = hc<App>('http://localhost');
export async function probe() {
  const res = await client.api.r${n - 1}.$get({ query: { page: '1' } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.items.map((item) => item.name);
}
`;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler',
    strict: true, skipLibCheck: true, noEmit: true, incremental: false, types: [],
  },
  include: ['*.ts'],
}, null, 2);

rmSync(OUT, { recursive: true, force: true });

for (const framework of ['elysia', 'hono']) {
  for (const n of SIZES) {
    const dir = join(OUT, `${framework}-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.ts'), framework === 'elysia' ? elysiaApp(n) : honoApp(n));
    writeFileSync(join(dir, 'usage.ts'), framework === 'elysia' ? elysiaUsage(n) : honoUsage(n));
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);

    let output = '';
    try {
      output = execFileSync(TSC, ['-p', 'tsconfig.json', '--extendedDiagnostics'], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const ts2589 = (output.match(/TS2589/g) ?? []).length;
    const errors = (output.match(/error TS/g) ?? []).length;
    const check = output.match(/Check time:\s+([\d.]+s)/)?.[1] ?? '?';
    const inst = output.match(/Instantiations:\s+(\d+)/)?.[1] ?? '?';
    console.log(`${framework.padEnd(6)} n=${String(n).padEnd(4)} errors=${errors} TS2589=${ts2589} check=${check} instantiations=${inst}`);
  }
}
