/**
 * MCP per-request container harness (#14): the lifecycle wrapper every MCP
 * route would otherwise duplicate around `elysia-mcp` in stateless mode.
 *
 * ## Per-request scope correlation (AsyncLocalStorage)
 *
 * `elysia-mcp` in stateless mode runs `authentication()` (in `onBeforeHandle`)
 * and `setupServer()` (in the route handler) with `await` points between them,
 * so concurrent requests interleave — a closure-singleton handoff between the
 * two would let request A's tools see request B's scope. Instead, the harness
 * wraps each request in an `AsyncLocalStorage.run()` with a request-private
 * holder object:
 *
 * - the outer route handler enters the ALS context and delegates to an inner
 *   Elysia app that hosts `elysia-mcp`;
 * - `authentication` resolves the scope via the injected `resolveScope` seam
 *   and writes it into **this request's** holder (read from the ALS store);
 * - `getContainer()` (passed to `registerTools`) reads the holder from the ALS
 *   store **at tool-invocation time** — the MCP SDK dispatches tool handlers
 *   within the request's async context, so each invocation sees its own scope;
 * - disposal happens in a `finally` tied to the request, after the response
 *   promise settles — each container is disposed exactly once, and only by its
 *   own request.
 *
 * ## `registerTools` runs at startup too
 *
 * `elysia-mcp` calls `setupServer` once eagerly at plugin creation (on a
 * server that never handles stateless traffic) and then once per request on a
 * fresh per-request server. `registerTools` must therefore be idempotent and
 * must NOT call `getContainer()` during registration — only inside tool
 * handlers, at invocation time. A registration-time call throws (and, because
 * the eager `setupServer` result is awaited by every request, would make every
 * request fail with a 500 — the error message says how to fix it).
 *
 * The auth differences (operator superadmin-grant synthesis vs. the simpler
 * customer flow) are the injected `resolveScope` seam: it receives the parsed
 * `scopeKey` + request context and returns either a staged `{ scope }` or an
 * early `{ response }` (e.g. a `jsonRpcError`).
 *
 * How the scope key is extracted from the URL is itself a seam
 * (`parseScopeKey`, required — there is deliberately no default URL
 * convention): use {@link createPathSegmentScopeParser} for a
 * `.../{segment}/:scopeKey/...` path layout, or supply any extractor — a
 * header, a constant (`() => 'default'`) for single-scope deployments.
 *
 * `elysia-mcp` and `@modelcontextprotocol/sdk` are OPTIONAL peers — only pulled
 * in by consumers of this `./mcp` subpath, keeping the root export free of them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Elysia } from 'elysia';
import { mcp, type McpContext } from 'elysia-mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '@octabits-io/foundation/logger';

/** Scope-key path segment convention: alphanumeric, hyphens, underscores. */
export const SCOPE_KEY_PATTERN = /^[a-zA-Z0-9-_]+$/;

/** Maximum accepted length of an extracted scope key. */
export const MAX_SCOPE_KEY_LENGTH = 256;

/**
 * Extracts the scope key from a request URL. Return `null` to reject the
 * request with the invalid-scope response.
 */
export type ParseScopeKey = (url: string) => string | null;

/**
 * Build a {@link ParseScopeKey} that extracts the scope key from the URL path
 * segment immediately following the **last** occurrence of `segment` — i.e. a
 * `.../{segment}/:scopeKey/...` convention. Matching the last occurrence means
 * an earlier client-controlled path component that happens to equal `segment`
 * cannot shift the extraction point. Returns `null` when `segment` is absent
 * or the following segment is missing, longer than
 * {@link MAX_SCOPE_KEY_LENGTH}, or fails {@link SCOPE_KEY_PATTERN}.
 *
 * E.g. `createPathSegmentScopeParser('scope')` for `/scope/:scopeKey/`; a
 * multi-tenant consumer passes `createPathSegmentScopeParser('tenant')` for a
 * `/tenant/:id/` URL layout.
 */
export function createPathSegmentScopeParser(segment: string): ParseScopeKey {
  return (url: string): string | null => {
    if (!segment) return null;
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
    const segments = pathname.split('/');
    const idx = segments.lastIndexOf(segment);
    if (idx < 0) return null;
    const candidate = segments[idx + 1];
    if (!candidate || candidate.length > MAX_SCOPE_KEY_LENGTH || !SCOPE_KEY_PATTERN.test(candidate)) {
      return null;
    }
    return candidate;
  };
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
   * Auth + scope seam. Receives the parsed `scopeKey` and the MCP request
   * context; returns a staged `{ scope }` (the harness disposes it after the
   * response / on error) or an early `{ response }` (e.g. `jsonRpcError(...)`).
   */
  resolveScope: (args: {
    scopeKey: string;
    context: McpContext;
  }) => Promise<ResolveScopeResult<S>>;
  /**
   * Register the domain tools/resources on an `McpServer`.
   *
   * Called once at startup (plugin creation) and once per request on a fresh
   * per-request server — it must be idempotent. `getContainer` is a lazy
   * accessor: calling it inside a tool handler returns the scope resolved for
   * the request currently being served; calling it during registration throws,
   * because no request (and therefore no scope) exists yet.
   */
  registerTools: (server: McpServer, getContainer: () => S) => void | Promise<void>;
  /** MCP server identity advertised to clients. */
  serverInfo: { name: string; version: string };
  /**
   * Extracts the scope key from the request URL; return `null` to reject.
   * Required — there is deliberately no default URL convention. Use
   * `createPathSegmentScopeParser('scope')` for a `/scope/:scopeKey/` layout,
   * `createPathSegmentScopeParser('tenant')` for a `/tenant/:id/` layout
   * (consumer vocabulary, their choice), or `() => 'default'` for single-scope
   * deployments.
   */
  parseScopeKey: ParseScopeKey;
  /** Elysia route prefix. Default `/mcp`. */
  prefix?: string;
  /** `elysia-mcp` base path within the prefix. Default `/`. */
  basePath?: string;
  /** MCP capabilities advertised to clients. Default `{ tools: {} }`. */
  capabilities?: ServerCapabilities;
  /** Response returned when `parseScopeKey` yields no scope key. Default `jsonRpcError(400, -32600, 'Invalid scope key')`. */
  invalidScopeResponse?: () => Response;
  /** Diagnostics (e.g. a scope `dispose()` failure after the response). */
  logger?: Logger;
}

/** Request-private carrier for the resolved scope, keyed by async context. */
interface ContainerHolder<S> {
  container: S | null;
}

/**
 * Build the `/mcp` route: `elysia-mcp` in stateless mode with a per-request
 * scope acquired in `authentication`, correlated to tool handlers via
 * `AsyncLocalStorage` (see the module docs for why this is interleaving-safe),
 * and disposed in a `finally` tied to the request.
 */
export const createMcpRoutes = <S extends DisposableScope>(options: CreateMcpRoutesOptions<S>) => {
  const {
    resolveScope,
    registerTools,
    serverInfo,
    parseScopeKey,
    prefix = '/mcp',
    basePath = '/',
    capabilities = { tools: {} },
    invalidScopeResponse = () => jsonRpcError(400, -32600, 'Invalid scope key'),
    logger,
  } = options;

  const storage = new AsyncLocalStorage<ContainerHolder<S>>();

  const getContainer = (): S => {
    const holder = storage.getStore();
    if (!holder) {
      throw new Error(
        'getContainer() called outside a request. registerTools runs once at startup '
        + '(and once per request) — only call getContainer() inside a tool handler, '
        + 'at invocation time, never during registration.',
      );
    }
    if (!holder.container) {
      throw new Error('No scope container was staged for this request.');
    }
    return holder.container;
  };

  // Inner app: the real elysia-mcp plugin. All of its per-request work
  // (authentication, per-request setupServer, tool dispatch) runs inside the
  // ALS context entered by the outer route handler below.
  const inner = new Elysia({ prefix }).use(mcp({
    basePath,
    stateless: true,
    enableJsonResponse: true,
    serverInfo,
    capabilities,
    authentication: async (context: McpContext) => {
      const scopeKey = parseScopeKey(context.request.url);
      if (!scopeKey) {
        return { response: invalidScopeResponse() };
      }

      const result = await resolveScope({ scopeKey, context });
      if (result.response) {
        return { response: result.response };
      }

      const holder = storage.getStore();
      if (!holder) {
        // Unreachable via the outer routes; fail closed rather than leak.
        await result.scope.dispose?.();
        return { response: jsonRpcError(500, -32603, 'Internal error') };
      }
      holder.container = result.scope;
      return {};
    },
    setupServer: async (server: McpServer) => {
      await registerTools(server, getContainer);
    },
  }));

  const handleRequest = async ({ request }: { request: Request }): Promise<Response> => {
    const holder: ContainerHolder<S> = { container: null };
    try {
      // Everything downstream — elysia-mcp's authentication hook, the
      // per-request setupServer, and tool handler execution — descends from
      // this async context, so getContainer() resolves this request's holder.
      return await storage.run(holder, () => inner.handle(request));
    } finally {
      const container = holder.container;
      holder.container = null;
      if (container) {
        try {
          await container.dispose?.();
        } catch (error) {
          logger?.error(
            'Failed to dispose MCP scope container',
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
  };

  // Mirror elysia-mcp's own route registration (`${basePath}/*` + `basePath`
  // under `prefix`) so the outer wrapper matches exactly what the inner app
  // serves. `parse: 'none'` keeps the body stream untouched for the inner app.
  return new Elysia({ prefix })
    .all(`${basePath}/*`, handleRequest, { parse: 'none' })
    .all(basePath, handleRequest, { parse: 'none' });
};
