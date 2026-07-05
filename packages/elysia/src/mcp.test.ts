import { describe, it, expect, vi } from 'vitest';
import { Elysia } from 'elysia';

// Mock the elysia-mcp boundary: `mcp(options)` returns a trivial Elysia plugin
// whose POST '/' route drives options.authentication → options.setupServer the
// same way the real stateless server does, so we can exercise the scope
// lifecycle without a live MCP client.
vi.mock('elysia-mcp', () => ({
  mcp: (options: {
    authentication: (ctx: unknown) => Promise<{ response?: Response }>;
    setupServer: (server: object) => Promise<void>;
  }) => {
    return new Elysia().post('/*', async (ctx) => {
      const authRes = await options.authentication(ctx);
      if (authRes?.response) return authRes.response;
      const server = {}; // fresh per-request McpServer stand-in
      await options.setupServer(server);
      if ((ctx as { request: Request }).request.headers.get('x-throw') === '1') {
        throw new Error('handler boom');
      }
      return { ok: true };
    });
  },
}));

const { createMcpRoutes, parseTenantId, jsonRpcError, SCOPE_KEY_PATTERN } = await import('./mcp');

describe('parseTenantId', () => {
  it('extracts the tenant id following the /tenant/ segment', () => {
    expect(parseTenantId('http://localhost/api/tenant/acme-1/mcp')).toBe('acme-1');
    expect(parseTenantId('http://localhost/api/tenant/tenant_42/mcp/foo')).toBe('tenant_42');
  });

  it('returns null when the tenant segment is absent or invalid', () => {
    expect(parseTenantId('http://localhost/api/mcp')).toBeNull();
    expect(parseTenantId('http://localhost/api/tenant/')).toBeNull();
    expect(parseTenantId('http://localhost/api/tenant/bad id/mcp')).toBeNull();
    expect(parseTenantId('http://localhost/api/tenant/bad.id/mcp')).toBeNull();
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

describe('createMcpRoutes scope lifecycle', () => {
  const makeScope = () => ({ resolve: vi.fn(), dispose: vi.fn(async () => {}) });

  it('stages the scope, exposes it to registerTools, and disposes on afterResponse', async () => {
    const scope = makeScope();
    let seenContainer: unknown;

    const app = createMcpRoutes({
      prefix: '',
      serverInfo: { name: 'test', version: '1.0.0' },
      resolveScope: async ({ scopeKey }) => {
        expect(scopeKey).toBe('acme');
        return { scope };
      },
      registerTools: (_server, getContainer) => {
        seenContainer = getContainer();
      },
    });

    const res = await app.handle(
      new Request('http://localhost/tenant/acme/', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Tool handlers see the exact scope staged by resolveScope.
    expect(seenContainer).toBe(scope);
    // onAfterResponse fires after handle() resolves — flush the task queue.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Disposed once after the response.
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns the invalid-scope response and never acquires a scope', async () => {
    const resolveScope = vi.fn();
    const app = createMcpRoutes({
      prefix: '',
      serverInfo: { name: 'test', version: '1.0.0' },
      resolveScope,
      registerTools: () => {},
    });

    const res = await app.handle(
      new Request('http://localhost/nope/', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid scope key' },
      id: null,
    });
    expect(resolveScope).not.toHaveBeenCalled();
  });

  it('uses a custom parseScopeKey and passes scopeKey to resolveScope', async () => {
    const scope = makeScope();
    const seen: string[] = [];

    const app = createMcpRoutes({
      prefix: '',
      serverInfo: { name: 'test', version: '1.0.0' },
      parseScopeKey: () => 'default',
      resolveScope: async ({ scopeKey }) => {
        seen.push(scopeKey);
        return { scope };
      },
      registerTools: () => {},
    });

    // No /tenant/ segment in the URL — the custom extractor supplies the key.
    const res = await app.handle(
      new Request('http://localhost/anything/', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual(['default']);
  });

  it('returns the resolveScope rejection response without staging a scope', async () => {
    const scope = makeScope();
    const app = createMcpRoutes({
      prefix: '',
      serverInfo: { name: 'test', version: '1.0.0' },
      resolveScope: async () => ({ response: jsonRpcError(403, -32002, 'Access denied') }),
      registerTools: () => {},
    });

    const res = await app.handle(
      new Request('http://localhost/tenant/acme/', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Access denied' },
      id: null,
    });
    expect(scope.dispose).not.toHaveBeenCalled();
  });

  it('disposes the scope when a tool handler throws', async () => {
    const scope = makeScope();
    const app = createMcpRoutes({
      prefix: '',
      serverInfo: { name: 'test', version: '1.0.0' },
      resolveScope: async () => ({ scope }),
      registerTools: () => {},
    });

    await app.handle(
      new Request('http://localhost/tenant/acme/', {
        method: 'POST',
        body: '{}',
        headers: { 'x-throw': '1' },
      }),
    );

    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });
});
