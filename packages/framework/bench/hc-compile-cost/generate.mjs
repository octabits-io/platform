/**
 * SPIKE (elysia-exit-option): synthetic app generator for the hc-vs-Eden
 * compile-cost measurement.
 *
 * Emits three variants at reynt's operator-api scale (5 domains x 21
 * resources = 105 route files, 5 endpoints each, realistic zod schemas +
 * per-status responses, plus ~3 client call sites per resource ~= the
 * console's remaining Eden surface):
 *
 *   out/elysia-eden     — Elysia routes + `treaty<App>` client (the baseline)
 *   out/hono-naive      — Hono chained routes + naive `hc<AppType>` client
 *   out/hono-mitigated  — same routes + the documented mitigations:
 *                         per-domain client split + pre-compiled client type
 *                         (`hcWithType` from the Hono RPC guide)
 *
 * Run: node generate.mjs && ./run.sh
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out');

const DOMAINS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const RESOURCES_PER_DOMAIN = 21;

/** deterministic resource names: alphaRes1 … epsilonRes21 */
function resources() {
  const list = [];
  for (const domain of DOMAINS) {
    for (let i = 1; i <= RESOURCES_PER_DOMAIN; i++) {
      list.push({ domain, name: `${domain}Res${i}`, path: `${domain}-res-${i}` });
    }
  }
  return list;
}

function pascal(name) {
  return name[0].toUpperCase() + name.slice(1);
}

/** Shared zod schema block — identical in every variant. */
function schemaBlock(name) {
  const P = pascal(name);
  return `
export const SCHEMA_${P} = z.object({
  id: z.string(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  price: z.number().min(0).max(99_999_999.99),
  quantity: z.number().int().min(0),
  active: z.boolean(),
  tags: z.array(z.string().max(100)),
  category: z.enum(['one', 'two', 'three']),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});
export type ${P} = z.infer<typeof SCHEMA_${P}>;
export const SCHEMA_${P}_CREATE = SCHEMA_${P}.omit({ id: true, createdAt: true, updatedAt: true });
export const SCHEMA_${P}_UPDATE = SCHEMA_${P}_CREATE.partial();
export const SCHEMA_${P}_LIST_QUERY = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(255).optional(),
  sort: z.enum(['name', 'createdAt']).optional(),
});
export const SCHEMA_${P}_LIST_RESPONSE = z.object({
  items: z.array(SCHEMA_${P}),
  total: z.number().int(),
});
export const SCHEMA_ERROR_${P} = z.object({ key: z.string(), message: z.string() });
`;
}

function stubValue(name) {
  const P = pascal(name);
  return `
const STUB_${P}: ${P} = {
  id: 'x', name: 'x', description: null, price: 1, quantity: 1, active: true,
  tags: [], category: 'one', createdAt: 'now', updatedAt: null,
};
`;
}

/* ---------------------------------------------------------------- elysia */

function elysiaRouteFile(res) {
  const P = pascal(res.name);
  return `import { Elysia } from 'elysia';
import { z } from 'zod';
${schemaBlock(res.name)}${stubValue(res.name)}
export const ${res.name}Routes = new Elysia({ prefix: '/${res.path}' })
  .get('/', ({ query }) => ({ items: [STUB_${P}], total: 1 }), {
    query: SCHEMA_${P}_LIST_QUERY,
    response: { 200: SCHEMA_${P}_LIST_RESPONSE, 400: SCHEMA_ERROR_${P}, 401: SCHEMA_ERROR_${P} },
  })
  .get('/:id', ({ params, status }) => params.id === 'missing' ? status(404, { key: 'not_found', message: 'x' }) : STUB_${P}, {
    response: { 200: SCHEMA_${P}, 404: SCHEMA_ERROR_${P}, 401: SCHEMA_ERROR_${P} },
  })
  .post('/', ({ body }) => ({ ...STUB_${P}, ...body }), {
    body: SCHEMA_${P}_CREATE,
    response: { 200: SCHEMA_${P}, 400: SCHEMA_ERROR_${P}, 401: SCHEMA_ERROR_${P}, 403: SCHEMA_ERROR_${P} },
  })
  .patch('/:id', ({ body }) => ({ ...STUB_${P}, ...body }), {
    body: SCHEMA_${P}_UPDATE,
    response: { 200: SCHEMA_${P}, 400: SCHEMA_ERROR_${P}, 404: SCHEMA_ERROR_${P} },
  })
  .delete('/:id', () => ({ deleted: true }), {
    response: { 200: z.object({ deleted: z.boolean() }), 404: SCHEMA_ERROR_${P} },
  });
`;
}

function elysiaApp(list) {
  const imports = list.map((r) => `import { ${r.name}Routes } from './routes/${r.name}';`).join('\n');
  const domainBlocks = DOMAINS.map((d) => {
    const uses = list.filter((r) => r.domain === d).map((r) => `.use(${r.name}Routes)`).join('\n  ');
    return `const ${d}Domain = new Elysia({ prefix: '/${d}' })\n  ${uses};`;
  }).join('\n\n');
  const uses = DOMAINS.map((d) => `.use(${d}Domain)`).join('\n  ');
  return `import { Elysia } from 'elysia';
${imports}

${domainBlocks}

export const app = new Elysia({ prefix: '/api' })
  ${uses};

export type App = typeof app;
`;
}

function edenUsage(res) {
  const P = pascal(res.name);
  return `import { treaty } from '@elysiajs/eden';
import type { App } from '../server/app';

const client = treaty<App>('http://localhost:3002');

export async function list${P}(search: string) {
  const { data, error } = await client.api.${res.domain}['${res.path}'].get({ query: { page: 1, search } });
  if (error) return null;
  return data.items.map((item) => item.name);
}

export async function read${P}(id: string) {
  const { data } = await client.api.${res.domain}['${res.path}']({ id }).get();
  return data?.price ?? 0;
}

export async function rename${P}(id: string, name: string) {
  const { data, error } = await client.api.${res.domain}['${res.path}']({ id }).patch({ name });
  if (error) return false;
  return data.name === name;
}
`;
}

/* ------------------------------------------------------------------ hono */

function honoRouteFile(res) {
  const P = pascal(res.name);
  return `import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
${schemaBlock(res.name)}${stubValue(res.name)}
export const ${res.name}Routes = new Hono()
  .get('/', zValidator('query', SCHEMA_${P}_LIST_QUERY), (c) => c.json({ items: [STUB_${P}], total: 1 }, 200))
  .get('/:id', (c) => c.req.param('id') === 'missing'
    ? c.json({ key: 'not_found', message: 'x' }, 404)
    : c.json(STUB_${P}, 200))
  .post('/', zValidator('json', SCHEMA_${P}_CREATE), (c) => c.json({ ...STUB_${P}, ...c.req.valid('json') }, 200))
  .patch('/:id', zValidator('json', SCHEMA_${P}_UPDATE), (c) => c.json({ ...STUB_${P}, ...c.req.valid('json') }, 200))
  .delete('/:id', (c) => c.json({ deleted: true }, 200));
`;
}

function honoApp(list) {
  const imports = list.map((r) => `import { ${r.name}Routes } from './routes/${r.name}';`).join('\n');
  const domainBlocks = DOMAINS.map((d) => {
    const routes = list.filter((r) => r.domain === d).map((r) => `.route('/${r.path}', ${r.name}Routes)`).join('\n  ');
    return `export const ${d}Domain = new Hono()\n  ${routes};\nexport type ${pascal(d)}Domain = typeof ${d}Domain;`;
  }).join('\n\n');
  const routes = DOMAINS.map((d) => `.route('/${d}', ${d}Domain)`).join('\n  ');
  return `import { Hono } from 'hono';
${imports}

${domainBlocks}

export const app = new Hono().basePath('/api')
  ${routes};

export type AppType = typeof app;
`;
}

function honoNaiveUsage(res) {
  const P = pascal(res.name);
  return `import { hc } from 'hono/client';
import type { AppType } from '../server/app';

const client = hc<AppType>('http://localhost:3002');

export async function list${P}(search: string) {
  const res = await client.api.${res.domain}['${res.path}'].$get({ query: { page: '1', search } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.items.map((item) => item.name);
}

export async function read${P}(id: string) {
  const res = await client.api.${res.domain}['${res.path}'][':id'].$get({ param: { id } });
  if (res.status !== 200) return 0;
  const data = await res.json();
  return data.price;
}

export async function rename${P}(id: string, name: string) {
  const res = await client.api.${res.domain}['${res.path}'][':id'].$patch({ param: { id }, json: { name } });
  if (!res.ok) return false;
  const data = await res.json();
  return 'name' in data && data.name === name;
}
`;
}

/**
 * The documented mitigation: compute the client type ONCE per domain in a
 * dedicated file (compiles the heavy generic a single time), consumers import
 * the pre-typed factory.
 */
function honoMitigatedClient(domain) {
  const P = pascal(domain);
  return `import { hc } from 'hono/client';
import type { ${P}Domain } from '../server/app';

// Pre-compiled client type: hc<...> is instantiated once, here, and nowhere else.
const client = hc<${P}Domain>('');
export type ${P}Client = typeof client;

export const create${P}Client = (...args: Parameters<typeof hc>): ${P}Client =>
  hc<${P}Domain>(...args);
`;
}

function honoMitigatedUsage(res) {
  const P = pascal(res.name);
  const D = pascal(res.domain);
  return `import { create${D}Client } from '../clients/${res.domain}';

const client = create${D}Client('http://localhost:3002');

export async function list${P}(search: string) {
  const res = await client['${res.path}'].$get({ query: { page: '1', search } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.items.map((item) => item.name);
}

export async function read${P}(id: string) {
  const res = await client['${res.path}'][':id'].$get({ param: { id } });
  if (res.status !== 200) return 0;
  const data = await res.json();
  return data.price;
}

export async function rename${P}(id: string, name: string) {
  const res = await client['${res.path}'][':id'].$patch({ param: { id }, json: { name } });
  if (!res.ok) return false;
  const data = await res.json();
  return 'name' in data && data.name === name;
}
`;
}

/* ------------------------------------------------------------------ emit */

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ESNext',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    incremental: false,
    types: [],
  },
  include: ['server/**/*', 'client/**/*', 'clients/**/*'],
}, null, 2);

function emit(variant, files) {
  const dir = join(OUT, variant);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
}

const list = resources();

emit('elysia-eden', {
  ...Object.fromEntries(list.map((r) => [`server/routes/${r.name}.ts`, elysiaRouteFile(r)])),
  'server/app.ts': elysiaApp(list),
  ...Object.fromEntries(list.map((r) => [`client/${r.name}.usage.ts`, edenUsage(r)])),
});

emit('hono-naive', {
  ...Object.fromEntries(list.map((r) => [`server/routes/${r.name}.ts`, honoRouteFile(r)])),
  'server/app.ts': honoApp(list),
  ...Object.fromEntries(list.map((r) => [`client/${r.name}.usage.ts`, honoNaiveUsage(r)])),
});

emit('hono-mitigated', {
  ...Object.fromEntries(list.map((r) => [`server/routes/${r.name}.ts`, honoRouteFile(r)])),
  'server/app.ts': honoApp(list),
  ...Object.fromEntries(DOMAINS.map((d) => [`clients/${d}.ts`, honoMitigatedClient(d)])),
  ...Object.fromEntries(list.map((r) => [`client/${r.name}.usage.ts`, honoMitigatedUsage(r)])),
});

console.log(`generated ${list.length} route files x 3 variants under ${OUT}`);
