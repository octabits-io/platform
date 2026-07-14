// ============================================================================
// @octabits-io/framework/elysia — reusable Elysia middleware & helpers
// ============================================================================
//
// Security headers, trusted-proxy client IP, error mapping + the ApiError family,
// and standard response schemas. Domain-agnostic: errors are foundation's
// `OctError` (`{ key, message }`), the logger is foundation's `Logger`, and
// domain key→status rules are injected via `statusOverrides`.

export * from './security-headers';
export * from './client-ip';
export * from './rate-limit';
export * from './responses';
export * from './errors';
export * from './config';
export * from './create-app';
export * from './health';

// NOTE: the MCP harness lives at the `./mcp` subpath (not re-exported here) so
// the root export stays free of the optional `elysia-mcp` /
// `@modelcontextprotocol/sdk` peers. Import it via `@octabits-io/framework/elysia/mcp`.
