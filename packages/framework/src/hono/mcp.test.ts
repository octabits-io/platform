/**
 * Hono port of `../elysia/mcp.test.ts` + `../elysia/mcp-nesting.test.ts`,
 * against the REAL `@hono/mcp` transport and a real `McpServer` (no mocks —
 * the mocked boundary in the original suite hid both the cross-request
 * container race and the eager registration call).
 *
 * Notably absent: the `Bun.randomUUIDv7` polyfill the Elysia suite needs.
 * `@hono/mcp` uses `crypto.randomUUID()` for its stream ids, so the harness
 * runs on plain Node with no globals patched (verified by the suite passing
 * without one).
 */
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DisposeOptions } from '../ioc/index.ts';
import { testRequest, type TestResponse } from '../server/testing';
import { testableHonoApp } from './testing';
import {
  createMcpRoutes,
  createPathSegmentScopeParser,
  jsonRpcError,
  SCOPE_KEY_PATTERN,
  MAX_SCOPE_KEY_LENGTH,
} from './mcp';

describe('createPathSegmentScopeParser', () => {
  const parseScope = createPathSegmentScopeParser('scope');

  it('extracts the scope key following the /scope/ segment', () => {
    expect(parseScope('http://localhost/api/scope/acme-1/mcp')).toBe('acme-1');
    expect(parseScope('http://localhost/api/scope/scope_42/mcp/foo')).toBe('scope_42');
  });

  it('returns null when the scope segment is absent or invalid', () => {
    expect(parseScope('http://localhost/api/mcp')).toBeNull();
    expect(parseScope('http://localhost/api/scope/')).toBeNull();
    expect(parseScope('http://localhost/api/scope/bad id/mcp')).toBeNull();
    expect(parseScope('http://localhost/api/scope/bad.id/mcp')).toBeNull();
  });

  it('matches the LAST occurrence of the segment, so an earlier path component cannot shift extraction', () => {
    expect(parseScope('http://localhost/docs/scope/x/scope/real')).toBe('real');
    expect(parseScope('http://localhost/scope/scope/key')).toBe('key');
  });

  it('caps the extracted key length', () => {
    const max = 'a'.repeat(MAX_SCOPE_KEY_LENGTH);
    const over = 'a'.repeat(MAX_SCOPE_KEY_LENGTH + 1);
    expect(parseScope(`http://localhost/scope/${max}/mcp`)).toBe(max);
    expect(parseScope(`http://localhost/scope/${over}/mcp`)).toBeNull();
  });

  it('extracts from a custom segment (e.g. a /tenant/ URL layout)', () => {
    const parseTenant = createPathSegmentScopeParser('tenant');
    expect(parseTenant('http://localhost/api/tenant/acme-1/mcp')).toBe('acme-1');
    // The custom segment does not match the default `scope` word.
    expect(parseTenant('http://localhost/api/scope/acme-1/mcp')).toBeNull();
  });

  it('exposes the url-friendly key pattern', () => {
    expect(SCOPE_KEY_PATTERN.test('a-b_C9')).toBe(true);
    expect(SCOPE_KEY_PATTERN.test('a/b')).toBe(false);
  });
});

describe('jsonRpcError', () => {
  it('builds a JSON-RPC 2.0 error Response with the given status', async () => {
    const res = jsonRpcError(403, -32002, 'nope');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ jsonrpc: '2.0', error: { code: -32002, message: 'nope' }, id: null });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle against the real @hono/mcp transport.
// ---------------------------------------------------------------------------

interface TestScope {
  id: string;
  dispose: ReturnType<typeof vi.fn<(opts?: DisposeOptions) => Promise<void>>>;
}

const makeScope = (id: string): TestScope => ({
  id,
  dispose: vi.fn<(opts?: DisposeOptions) => Promise<void>>(async () => {}),
});

const RPC_HEADERS = { accept: 'application/json, text/event-stream' };

/** JSON-RPC request body. */
const rpcBody = (method: string, params: Record<string, unknown> = {}, id = 1) =>
  ({ jsonrpc: '2.0', id, method, params });

/** Raw `Request` for the cases that need concurrency or a bare fetch. */
const rpcRequest = (path: string, method: string, params: Record<string, unknown> = {}, id = 1) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...RPC_HEADERS },
    body: JSON.stringify(rpcBody(method, params, id)),
  });

/** Drive one JSON-RPC call through the framework-agnostic test harness. */
const rpc = (
  app: Hono,
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<TestResponse> =>
  testRequest(testableHonoApp(app), 'POST', path, { body: rpcBody(method, params, id), headers: RPC_HEADERS });

const initialize = (app: Hono, path: string) =>
  rpc(app, path, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  });

const callTool = (app: Hono, path: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(app, path, 'tools/call', { name, arguments: args });

/** First text content of a tools/call result (or the raw body, for diagnosis). */
const firstText = (data: unknown): string => {
  const body = data as { result?: { content?: Array<{ text?: string }> } };
  return body.result?.content?.[0]?.text ?? JSON.stringify(data);
};

/**
 * Register a `whoami` tool that reports the container id; `delayMs` lets tests
 * hold a tool invocation open while other requests complete.
 */
function registerWhoami(server: McpServer, getContainer: () => TestScope) {
  server.registerTool(
    'whoami',
    { inputSchema: { delayMs: z.number().optional() } },
    async ({ delayMs }: { delayMs?: number }) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: 'text' as const, text: getContainer().id }] };
    },
  );
}

describe('createMcpRoutes scope lifecycle (real @hono/mcp)', () => {
  it('answers the initialize handshake with the configured serverInfo', async () => {
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test-server', version: '2.1.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope: makeScope('acme') }),
      registerTools: registerWhoami,
    });

    const res = await initialize(app, '/mcp/scope/acme');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'test-server', version: '2.1.0' } },
    });
  });

  it('lists the registered tools', async () => {
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope: makeScope('acme') }),
      registerTools: registerWhoami,
    });

    const res = await rpc(app, '/mcp/scope/acme', 'tools/list');
    expect(res.status).toBe(200);
    const tools = (res.data as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['whoami']);
  });

  it('resolves the scope, exposes it to tool handlers, and disposes exactly once with commit', async () => {
    const scope = makeScope('acme-container');
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async ({ scopeKey, url }) => {
        expect(scopeKey).toBe('acme');
        // Unlike the Elysia harness, nothing re-addresses the request — `url`
        // is the public URL and equals `context.req.url`.
        expect(url).toBe('http://localhost/mcp/scope/acme');
        return { scope };
      },
      registerTools: registerWhoami,
    });

    const res = await callTool(app, '/mcp/scope/acme', 'whoami');
    expect(res.status).toBe(200);
    expect(firstText(res.data)).toBe('acme-container');
    expect(scope.dispose).toHaveBeenCalledTimes(1);
    expect(scope.dispose).toHaveBeenCalledWith({ commit: true });
  });

  it('interleaved concurrent requests each see their own scope even when resolveScope resolves in inverted order', async () => {
    const scopes = new Map<string, TestScope>();
    const release = new Map<string, () => void>();

    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      // Deferred: each request's resolveScope blocks until the test releases it.
      resolveScope: ({ scopeKey }) =>
        new Promise((resolve) => {
          release.set(scopeKey, () => {
            const scope = makeScope(scopeKey);
            scopes.set(scopeKey, scope);
            resolve({ scope });
          });
        }),
      registerTools: registerWhoami,
    });

    const handle = testableHonoApp(app).handle;
    const call = (key: string, id: number, delayMs?: number) =>
      handle(rpcRequest(`/mcp/scope/${key}`, 'tools/call', {
        name: 'whoami',
        arguments: delayMs ? { delayMs } : {},
      }, id));

    // Request A arrives first, request B second…
    const resAPromise = call('alpha', 1, 25);
    await vi.waitFor(() => expect(release.has('alpha')).toBe(true));
    const resBPromise = call('beta', 2);
    await vi.waitFor(() => expect(release.has('beta')).toBe(true));

    // …but B's scope resolution completes FIRST (inverted order). A shared
    // server/transport (the @hono/mcp README shape) would cross the wires here.
    release.get('beta')!();
    const resB = await resBPromise; // B fully completes (incl. disposal)…
    release.get('alpha')!();        // …while A is still resolving; A's tool then
    const resA = await resAPromise; // runs after B's container was disposed.

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(firstText(await resA.json())).toBe('alpha');
    expect(firstText(await resB.json())).toBe('beta');

    // Each container disposed exactly once, by its own request.
    expect(scopes.get('alpha')!.dispose).toHaveBeenCalledTimes(1);
    expect(scopes.get('beta')!.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns the invalid-scope response and never acquires a scope', async () => {
    const resolveScope = vi.fn();
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope,
      registerTools: registerWhoami,
    });

    // `bad.id` fails SCOPE_KEY_PATTERN → parseScopeKey yields null.
    const res = await callTool(app, '/mcp/scope/bad.id', 'whoami');
    expect(res.status).toBe(400);
    expect(res.data).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid scope key' },
      id: null,
    });
    expect(resolveScope).not.toHaveBeenCalled();
  });

  it('honors a custom invalidScopeResponse', async () => {
    const app = createMcpRoutes<TestScope>({
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: () => null,
      invalidScopeResponse: () => jsonRpcError(418, -1, 'no scope here'),
      resolveScope: async () => ({ scope: makeScope('never') }),
      registerTools: registerWhoami,
    });

    const res = await callTool(app, '/mcp', 'whoami');
    expect(res.status).toBe(418);
    expect(res.data).toMatchObject({ error: { code: -1, message: 'no scope here' } });
  });

  it('uses a custom parseScopeKey and passes scopeKey to resolveScope', async () => {
    const scope = makeScope('default-container');
    const seen: string[] = [];
    const app = createMcpRoutes<TestScope>({
      basePath: '/',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: () => 'default',
      resolveScope: async ({ scopeKey }) => {
        seen.push(scopeKey);
        return { scope };
      },
      registerTools: registerWhoami,
    });

    // No /scope/ segment in the URL — the custom extractor supplies the key.
    const res = await callTool(app, '/mcp', 'whoami');
    expect(res.status).toBe(200);
    expect(firstText(res.data)).toBe('default-container');
    expect(seen).toEqual(['default']);
  });

  it('returns the resolveScope rejection response without staging a scope', async () => {
    const scope = makeScope('never');
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ response: jsonRpcError(403, -32002, 'Access denied') }),
      registerTools: registerWhoami,
    });

    const res = await callTool(app, '/mcp/scope/acme', 'whoami');
    expect(res.status).toBe(403);
    expect(res.data).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Access denied' },
      id: null,
    });
    expect(scope.dispose).not.toHaveBeenCalled();
  });

  it('gives resolveScope the Hono context (header-based auth reaches the client verbatim)', async () => {
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async ({ context, scopeKey }) => {
        if (context.req.header('authorization') !== 'Bearer good') {
          return { response: jsonRpcError(401, -32001, 'Unauthorized') };
        }
        return { scope: makeScope(scopeKey) };
      },
      registerTools: registerWhoami,
    });

    const denied = await testRequest(testableHonoApp(app), 'POST', '/mcp/scope/acme', {
      body: rpcBody('tools/call', { name: 'whoami', arguments: {} }),
      headers: RPC_HEADERS,
      token: 'bad',
    });
    expect(denied.status).toBe(401);
    expect(denied.data).toMatchObject({ error: { code: -32001, message: 'Unauthorized' } });

    const allowed = await testRequest(testableHonoApp(app), 'POST', '/mcp/scope/acme', {
      body: rpcBody('tools/call', { name: 'whoami', arguments: {} }),
      headers: RPC_HEADERS,
      token: 'good',
    });
    expect(allowed.status).toBe(200);
    expect(firstText(allowed.data)).toBe('acme');
  });

  it('disposes the scope when a tool handler throws', async () => {
    const scope = makeScope('boom-container');
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope }),
      registerTools: (server, getContainer) => {
        server.registerTool('boom', {}, async () => {
          getContainer();
          throw new Error('handler boom');
        });
      },
    });

    const res = await callTool(app, '/mcp/scope/acme', 'boom');
    // The MCP SDK converts tool-handler throws into an isError tool result;
    // the scope must be released regardless — and the request DID produce a
    // response, so it commits.
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ result: { isError: true } });
    expect(scope.dispose).toHaveBeenCalledTimes(1);
    expect(scope.dispose).toHaveBeenCalledWith({ commit: true });
  });

  it('disposes with commit:false when the request fails outright', async () => {
    const scope = makeScope('failing');
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope }),
      registerTools: () => { throw new Error('registration exploded'); },
    });

    const res = await callTool(app, '/mcp/scope/acme', 'whoami');
    expect(res.status).toBe(500);
    expect(scope.dispose).toHaveBeenCalledWith({ commit: false });
  });

  it('swallows and logs a dispose failure instead of masking the response', async () => {
    const error = vi.fn();
    const scope: TestScope = {
      id: 'leaky',
      dispose: vi.fn<(opts?: DisposeOptions) => Promise<void>>(async () => { throw new Error('dispose kaput'); }),
    };
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope }),
      registerTools: registerWhoami,
      logger: {
        debug: () => {}, info: () => {}, warn: () => {}, error,
        child: () => { throw new Error('unused'); },
      },
    });

    const res = await callTool(app, '/mcp/scope/acme', 'whoami');
    expect(res.status).toBe(200);
    expect(firstText(res.data)).toBe('leaky');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('dispose'), expect.any(Error));
  });

  it('registers tools once per request, with the container available during registration', async () => {
    // The Elysia harness registered eagerly at plugin creation with no
    // container (getContainer() threw during registration). Per-request
    // construction removes that constraint entirely.
    const seenAtRegistration: string[] = [];
    let registrations = 0;
    const app = createMcpRoutes<TestScope>({
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async ({ scopeKey }) => ({ scope: makeScope(scopeKey) }),
      registerTools: (server, getContainer) => {
        registrations += 1;
        seenAtRegistration.push(getContainer().id);
        registerWhoami(server, getContainer);
      },
    });

    // Nothing runs at creation time.
    expect(registrations).toBe(0);

    expect((await callTool(app, '/mcp/scope/one', 'whoami')).status).toBe(200);
    expect((await callTool(app, '/mcp/scope/two', 'whoami')).status).toBe(200);
    expect(registrations).toBe(2);
    expect(seenAtRegistration).toEqual(['one', 'two']);
  });
});

// ---------------------------------------------------------------------------
// Composition under prefixed parents — the regression guard ported from
// `../elysia/mcp-nesting.test.ts` (there the inner app's own prefix made every
// nested request 404). Each case asserts HTTP-level DISPATCH: a JSON-RPC
// response rather than a 404.
// ---------------------------------------------------------------------------

function makeMcp(parseScopeKey = createPathSegmentScopeParser('scope'), basePath?: string) {
  return createMcpRoutes<TestScope>({
    parseScopeKey,
    resolveScope: async ({ scopeKey }) => ({ scope: makeScope(scopeKey) }),
    registerTools: registerWhoami,
    serverInfo: { name: 'nesting-test', version: '0.0.0' },
    ...(basePath ? { basePath } : {}),
  });
}

const serverName = (data: unknown) =>
  (data as { result?: { serverInfo?: { name?: string } } }).result?.serverInfo?.name;

describe('createMcpRoutes mounted under prefixed parents', () => {
  it('dispatches when the factory app is used directly (control)', async () => {
    const res = await initialize(makeMcp(() => 'root-scope'), '/mcp');
    expect(res.status).toBe(200);
    expect(serverName(res.data)).toBe('nesting-test');
  });

  it('dispatches under a single static prefixed parent', async () => {
    const app = new Hono().route('/api', makeMcp(() => 's1'));
    expect((await initialize(app, '/api/mcp')).status).toBe(200);
  });

  it('dispatches under nested static + param-carrying parents (the consumer shape)', async () => {
    const scoped = new Hono().route('/scope/:scopeKey', makeMcp());
    const app = new Hono().route('/api', scoped);

    const res = await initialize(app, '/api/scope/acme-1/mcp');
    expect(res.status).toBe(200);
    expect(serverName(res.data)).toBe('nesting-test');
  });

  it('resolves the scope from the FULL request URL when nested (tool sees the right container)', async () => {
    const scoped = new Hono().route('/scope/:scopeKey', makeMcp());
    const app = new Hono().route('/api', scoped);

    const res = await callTool(app, '/api/scope/acme-1/mcp', 'whoami');
    expect(res.status).toBe(200);
    expect(firstText(res.data)).toBe('acme-1');
  });

  it('dispatches wildcard subpaths under nesting', async () => {
    const scoped = new Hono().route('/scope/:scopeKey', makeMcp());
    const app = new Hono().route('/api', scoped);

    // The MCP transport does not route on the path, so a subpath is still a
    // valid dispatch target.
    expect((await initialize(app, '/api/scope/acme-1/mcp/extra')).status).toBe(200);
  });

  it('still rejects an unparseable scope key with the invalid-scope response when nested', async () => {
    const scoped = new Hono().route('/other/:key', makeMcp());
    const app = new Hono().route('/api', scoped);

    // No /scope/ segment → parseScopeKey returns null → 400, which proves
    // dispatch reached the harness (a routing failure would be 404).
    const res = await initialize(app, '/api/other/x/mcp');
    expect(res.status).toBe(400);
    expect((res.data as { error?: { message?: string } }).error?.message).toBe('Invalid scope key');
  });

  it('honors a custom basePath under nesting', async () => {
    const app = new Hono().route('/api', makeMcp(() => 'fixed', '/v1'));

    expect((await initialize(app, '/api/mcp/v1')).status).toBe(200);
    expect((await initialize(app, '/api/mcp/v1/sub')).status).toBe(200);
    // Outside the basePath there is no route.
    expect((await initialize(app, '/api/mcp')).status).toBe(404);
  });
});
