import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
// Load elysia (and elysia-mcp's bundled copy) BEFORE the Bun polyfill below so
// their runtime detection (`typeof Bun`) still resolves to the Node adapter.
import { Elysia } from 'elysia';
import 'elysia-mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpRoutes, createPathSegmentScopeParser } from './mcp';

// elysia-mcp's transport calls `Bun.randomUUIDv7()` at request time — polyfill
// just that for the Node test runner (see mcp.test.ts for details).
const hadBunGlobal = 'Bun' in globalThis;
if (!hadBunGlobal) {
  (globalThis as Record<string, unknown>).Bun = { randomUUIDv7: () => randomUUID() };
}
afterAll(() => {
  if (!hadBunGlobal) {
    delete (globalThis as Record<string, unknown>).Bun;
  }
});

interface TestScope {
  id: string;
  dispose?: () => Promise<void>;
}

function registerWhoami(server: McpServer, getContainer: () => TestScope) {
  server.registerTool('whoami', {}, async () => ({
    content: [{ type: 'text' as const, text: getContainer().id }],
  }));
}

function makeMcp(parseScopeKey = createPathSegmentScopeParser('scope')) {
  return createMcpRoutes<TestScope>({
    parseScopeKey,
    resolveScope: async ({ scopeKey }) => ({ scope: { id: scopeKey } }),
    registerTools: registerWhoami,
    serverInfo: { name: 'nesting-test', version: '0.0.0' },
  });
}

function rpc(path: string, method: string, params: Record<string, unknown> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

const initialize = (path: string) =>
  rpc(path, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });

const callWhoami = (path: string) =>
  rpc(path, 'tools/call', { name: 'whoami', arguments: {} });

/**
 * Regression guard for the nested-prefix incident: the plugin returned by
 * createMcpRoutes used to build its inner elysia-mcp app with its own
 * `{ prefix }`, so once the plugin was `.use()`'d under a prefixed parent the
 * delegated request URL (carrying the parent prefix) matched nothing inside
 * `inner.handle()` — the outer routes appeared in `app.routes` but every
 * request 404'd. These tests assert HTTP-level DISPATCH (a JSON-RPC response,
 * not NOT_FOUND) at each nesting depth, so an elysia bump or a refactor of the
 * inner app cannot silently regress it.
 */
describe('createMcpRoutes nested under prefixed parents', () => {
  it('dispatches when mounted on the root app (control)', async () => {
    const app = new Elysia().use(makeMcp(() => 'root-scope'));
    const res = await app.handle(initialize('/mcp'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('nesting-test');
  });

  it('dispatches under a single static prefixed parent', async () => {
    const app = new Elysia().use(new Elysia({ prefix: '/api' }).use(makeMcp(() => 's1')));
    const res = await app.handle(initialize('/api/mcp'));
    expect(res.status).toBe(200);
  });

  it('dispatches under nested static + dynamic prefixed parents (the consumer shape)', async () => {
    const scoped = new Elysia({ prefix: '/scope/:scopeKey' }).use(makeMcp());
    const api = new Elysia({ prefix: '/api' }).use(scoped);
    const app = new Elysia().use(api);

    const res = await app.handle(initialize('/api/scope/acme-1/mcp'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('nesting-test');
  });

  it('resolves the scope from the FULL request URL when nested (tool sees the right container)', async () => {
    const scoped = new Elysia({ prefix: '/scope/:scopeKey' }).use(makeMcp());
    const app = new Elysia().use(new Elysia({ prefix: '/api' }).use(scoped));

    const res = await app.handle(callWhoami('/api/scope/acme-1/mcp'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
    expect(body.result?.content?.[0]?.text).toBe('acme-1');
  });

  it('dispatches wildcard subpaths under nesting', async () => {
    const scoped = new Elysia({ prefix: '/scope/:scopeKey' }).use(makeMcp());
    const app = new Elysia().use(new Elysia({ prefix: '/api' }).use(scoped));

    // Subpath still reaches the handler (initialize on a subpath is fine for
    // dispatch purposes — the MCP transport does not route on the path).
    const res = await app.handle(initialize('/api/scope/acme-1/mcp/extra'));
    expect(res.status).toBe(200);
  });

  it('still rejects an unparseable scope key with the invalid-scope response when nested', async () => {
    const scoped = new Elysia({ prefix: '/other/:key' }).use(makeMcp());
    const app = new Elysia().use(new Elysia({ prefix: '/api' }).use(scoped));

    // No /scope/ segment in the URL → parseScopeKey returns null → 400, which
    // proves dispatch reached the harness (a routing failure would be 404).
    const res = await app.handle(initialize('/api/other/x/mcp'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Invalid scope key');
  });

  it('honors a custom basePath under nesting', async () => {
    const child = createMcpRoutes<TestScope>({
      parseScopeKey: () => 'fixed',
      resolveScope: async ({ scopeKey }) => ({ scope: { id: scopeKey } }),
      registerTools: registerWhoami,
      serverInfo: { name: 'nesting-test', version: '0.0.0' },
      prefix: '/mcp',
      basePath: '/v1',
    });
    const app = new Elysia().use(new Elysia({ prefix: '/api' }).use(child));

    expect((await app.handle(initialize('/api/mcp/v1'))).status).toBe(200);
    expect((await app.handle(initialize('/api/mcp/v1/sub'))).status).toBe(200);
    // Outside the basePath there is no route.
    expect((await app.handle(initialize('/api/mcp'))).status).toBe(404);
  });
});
