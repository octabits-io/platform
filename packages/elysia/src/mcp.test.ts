import { describe, it, expect, vi, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
// Load elysia (and elysia-mcp's bundled copy) BEFORE the Bun polyfill below so
// their runtime detection (`typeof Bun`) still resolves to the Node adapter.
import 'elysia';
import 'elysia-mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createMcpRoutes,
  createPathSegmentScopeParser,
  jsonRpcError,
  SCOPE_KEY_PATTERN,
  MAX_SCOPE_KEY_LENGTH,
} from './mcp';

// These tests run against the REAL `elysia-mcp` (no mock): the earlier mocked
// boundary hid both the cross-request container race and the eager
// mount-time `setupServer` call. elysia-mcp's transport calls
// `Bun.randomUUIDv7()` at request time — polyfill just that for the Node test
// runner, and remove it afterwards so other test files are unaffected.
const hadBunGlobal = 'Bun' in globalThis;
if (!hadBunGlobal) {
  (globalThis as Record<string, unknown>).Bun = { randomUUIDv7: () => randomUUID() };
}
afterAll(() => {
  if (!hadBunGlobal) {
    delete (globalThis as Record<string, unknown>).Bun;
  }
});

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
// Lifecycle tests against the real elysia-mcp stateless flow.
// ---------------------------------------------------------------------------

interface TestScope {
  id: string;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const makeScope = (id: string): TestScope => ({ id, dispose: vi.fn<() => Promise<void>>(async () => {}) });

/** JSON-RPC tools/call request against the harness. */
function rpcCall(path: string, id: number, tool: string, args: Record<string, unknown> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
}

/** Extract the first text content of a tools/call result. */
async function firstText(res: Response): Promise<string> {
  const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  return body.result?.content?.[0]?.text ?? JSON.stringify(body);
}

/**
 * Register a `whoami` tool that resolves the container lazily at invocation
 * time (never during registration) and reports the container id; `delayMs`
 * lets tests hold a tool invocation open while other requests complete.
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

describe('createMcpRoutes scope lifecycle (real elysia-mcp)', () => {
  it('resolves the scope, exposes it to tool handlers at invocation time, and disposes exactly once', async () => {
    const scope = makeScope('acme-container');
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async ({ scopeKey }) => {
        expect(scopeKey).toBe('acme');
        return { scope };
      },
      registerTools: registerWhoami,
    });

    const res = await app.handle(rpcCall('/mcp/scope/acme', 1, 'whoami'));
    expect(res.status).toBe(200);
    expect(await firstText(res)).toBe('acme-container');
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('interleaved concurrent requests each see their own scope even when resolveScope resolves in inverted order', async () => {
    const scopes = new Map<string, TestScope>();
    const release = new Map<string, () => void>();

    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
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

    // Request A arrives first, request B second…
    const resAPromise = app.handle(rpcCall('/mcp/scope/alpha', 1, 'whoami', { delayMs: 25 }));
    await vi.waitFor(() => expect(release.has('alpha')).toBe(true));
    const resBPromise = app.handle(rpcCall('/mcp/scope/beta', 2, 'whoami'));
    await vi.waitFor(() => expect(release.has('beta')).toBe(true));

    // …but B's scope resolution completes FIRST (inverted order). Under the old
    // closure-singleton handoff, B's container would overwrite A's staging slot.
    release.get('beta')!();
    const resB = await resBPromise; // B fully completes (incl. disposal)…
    release.get('alpha')!();        // …while A is still resolving; A's tool then
    const resA = await resAPromise; // runs after B's container was disposed.

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(await firstText(resA)).toBe('alpha');
    expect(await firstText(resB)).toBe('beta');

    // Each container disposed exactly once, by its own request.
    expect(scopes.get('alpha')!.dispose).toHaveBeenCalledTimes(1);
    expect(scopes.get('beta')!.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns the invalid-scope response and never acquires a scope', async () => {
    const resolveScope = vi.fn();
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope,
      registerTools: registerWhoami,
    });

    // `bad.id` fails SCOPE_KEY_PATTERN → parseScopeKey yields null.
    const res = await app.handle(rpcCall('/mcp/scope/bad.id', 1, 'whoami'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid scope key' },
      id: null,
    });
    expect(resolveScope).not.toHaveBeenCalled();
  });

  it('uses a custom parseScopeKey and passes scopeKey to resolveScope', async () => {
    const scope = makeScope('default-container');
    const seen: string[] = [];
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
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
    const res = await app.handle(rpcCall('/mcp', 1, 'whoami'));
    expect(res.status).toBe(200);
    expect(await firstText(res)).toBe('default-container');
    expect(seen).toEqual(['default']);
  });

  it('returns the resolveScope rejection response without staging a scope', async () => {
    const scope = makeScope('never');
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ response: jsonRpcError(403, -32002, 'Access denied') }),
      registerTools: registerWhoami,
    });

    const res = await app.handle(rpcCall('/mcp/scope/acme', 1, 'whoami'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Access denied' },
      id: null,
    });
    expect(scope.dispose).not.toHaveBeenCalled();
  });

  it('disposes the scope when a tool handler throws', async () => {
    const scope = makeScope('boom-container');
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
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

    const res = await app.handle(rpcCall('/mcp/scope/acme', 1, 'boom'));
    // The MCP SDK converts tool-handler throws into an isError tool result;
    // the scope must be released regardless.
    expect(res.status).toBe(200);
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('createMcpRoutes startup (eager setupServer)', () => {
  it('registers tools eagerly at creation without needing a container, and requests still work', async () => {
    let registrations = 0;
    const scope = makeScope('startup-container');
    const app = createMcpRoutes<TestScope>({
      prefix: '/mcp',
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope }),
      registerTools: (server, getContainer) => {
        registrations += 1;
        registerWhoami(server, getContainer);
      },
    });

    // elysia-mcp calls setupServer once at plugin creation, before any request.
    await vi.waitFor(() => expect(registrations).toBeGreaterThanOrEqual(1));

    const res = await app.handle(rpcCall('/mcp/scope/acme', 1, 'whoami'));
    expect(res.status).toBe(200);
    expect(await firstText(res)).toBe('startup-container');
    // Stateless mode registers again on the per-request server.
    expect(registrations).toBeGreaterThanOrEqual(2);
  });

  it('getContainer() called during registration throws a clear error', async () => {
    let captured: unknown;
    createMcpRoutes<TestScope>({
      prefix: '/mcp',
      basePath: '/scope',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: createPathSegmentScopeParser('scope'),
      resolveScope: async () => ({ scope: makeScope('x') }),
      registerTools: (_server, getContainer) => {
        try {
          getContainer();
        } catch (error) {
          captured = error;
        }
      },
    });

    await vi.waitFor(() => expect(captured).toBeDefined());
    expect(String(captured)).toMatch(/outside a request/i);
    expect(String(captured)).toMatch(/tool handler/i);
  });
});
