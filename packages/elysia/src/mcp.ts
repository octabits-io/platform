/**
 * MCP per-request container harness (#14): the lifecycle wrapper both reynt MCP
 * routes (operator + customer) duplicate around `elysia-mcp` in stateless mode.
 *
 * `elysia-mcp` is stateless — a fresh `McpServer` per request, with
 * `authentication()` and `setupServer()` running sequentially (no interleaving),
 * so a closure-local `pendingContainer` is safe for the handoff and a
 * `WeakMap<McpServer, scope>` carries the scope through to each tool handler.
 * `onAfterResponse`/`onError` dispose the scope (releasing its DB connection).
 *
 * The auth differences (operator superadmin-grant synthesis vs. the simpler
 * customer flow) are the injected `resolveScope` seam: it receives the parsed
 * `tenantId` + request context and returns either a staged `{ scope }` or an
 * early `{ response }` (e.g. a `jsonRpcError`). Tool registration is the
 * injected `registerTools(server, getContainer)` seam.
 *
 * `elysia-mcp` and `@modelcontextprotocol/sdk` are OPTIONAL peers — only pulled
 * in by consumers of this `./mcp` subpath, keeping the root export free of them.
 */
import { Elysia } from 'elysia';
import { mcp, type McpContext } from 'elysia-mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '@octabits-io/foundation/logger';

/** Tenant-id path segment convention: alphanumeric, hyphens, underscores. */
export const TENANT_ID_PATTERN = /^[a-zA-Z0-9-_]+$/;

/**
 * Extract the tenant id from an MCP request URL of the shape
 * `.../tenant/:tenantId/...`. Returns `null` when the `tenant` segment is
 * absent or the following segment is missing / fails {@link TENANT_ID_PATTERN}.
 */
export function parseTenantId(url: string): string | null {
  const pathname = new URL(url).pathname;
  const segments = pathname.split('/');
  const idx = segments.indexOf('tenant');
  if (idx < 0) return null;
  const candidate = segments[idx + 1];
  if (!candidate || !TENANT_ID_PATTERN.test(candidate)) return null;
  return candidate;
}

/** Build a JSON-RPC 2.0 error `Response` with the given HTTP status. */
export function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** A per-request scope/container that can release its resources. */
export interface DisposableScope {
  dispose?: () => void | Promise<void>;
}

/**
 * Result of {@link CreateMcpRoutesOptions.resolveScope}: either a staged scope
 * (auth succeeded) or an early `Response` (auth rejected, e.g. `jsonRpcError`).
 */
export type ResolveScopeResult<S extends DisposableScope> =
  | { scope: S; response?: undefined }
  | { response: Response; scope?: undefined };

export interface CreateMcpRoutesOptions<S extends DisposableScope> {
  /**
   * Auth + scope seam. Receives the parsed `tenantId` and the MCP request
   * context; returns a staged `{ scope }` (the harness disposes it after the
   * response / on error) or an early `{ response }` (e.g. `jsonRpcError(...)`).
   */
  resolveScope: (args: { tenantId: string; context: McpContext }) => Promise<ResolveScopeResult<S>>;
  /**
   * Register the domain tools/resources on the per-request server. `getContainer`
   * returns the scope staged by `resolveScope` for this request.
   */
  registerTools: (server: McpServer, getContainer: () => S) => void | Promise<void>;
  /** MCP server identity advertised to clients. */
  serverInfo: { name: string; version: string };
  /** Elysia route prefix. Default `/mcp`. */
  prefix?: string;
  /** `elysia-mcp` base path within the prefix. Default `/`. */
  basePath?: string;
  /** MCP capabilities advertised to clients. Default `{ tools: {} }`. */
  capabilities?: ServerCapabilities;
  /** Response returned when the URL has no valid tenant id. Default `jsonRpcError(400, -32600, 'Invalid tenantId')`. */
  invalidTenantResponse?: () => Response;
  /** Reserved for future diagnostics; currently unused by the harness itself. */
  logger?: Logger;
}

/**
 * Build the `/mcp` route: `elysia-mcp` in stateless mode with a per-request
 * scope acquired in `authentication`, handed to tool handlers via a
 * `WeakMap<McpServer, scope>`, and disposed on `onAfterResponse`/`onError`.
 */
export const createMcpRoutes = <S extends DisposableScope>(options: CreateMcpRoutesOptions<S>) => {
  const {
    resolveScope,
    registerTools,
    serverInfo,
    prefix = '/mcp',
    basePath = '/',
    capabilities = { tools: {} },
    invalidTenantResponse = () => jsonRpcError(400, -32600, 'Invalid tenantId'),
  } = options;

  // Keyed by the per-request McpServer instance — carries the scope from
  // setupServer through to each tool handler's getContainer() closure.
  const serverContainers = new WeakMap<McpServer, S>();

  let pendingContainer: S | null = null;
  let activeContainer: S | null = null;

  const disposeActiveContainer = async () => {
    const container = activeContainer;
    activeContainer = null;
    await container?.dispose?.();
  };

  return new Elysia({ prefix })
    .onAfterResponse(disposeActiveContainer)
    .onError(disposeActiveContainer)
    .use(mcp({
      basePath,
      stateless: true,
      enableJsonResponse: true,
      serverInfo,
      capabilities,
      authentication: async (context: McpContext) => {
        const tenantId = parseTenantId(context.request.url);
        if (!tenantId) {
          return { response: invalidTenantResponse() };
        }

        const result = await resolveScope({ tenantId, context });
        if (result.response) {
          return { response: result.response };
        }

        // Stage the scope for setupServer to move into the WeakMap.
        pendingContainer = result.scope;
        return {};
      },
      setupServer: async (server: McpServer) => {
        const container = pendingContainer!;
        pendingContainer = null;
        activeContainer = container;
        serverContainers.set(server, container);

        const getContainer = () => {
          const c = serverContainers.get(server);
          if (!c) throw new Error('No container for this MCP server instance');
          return c;
        };

        await registerTools(server, getContainer);
      },
    }));
};
