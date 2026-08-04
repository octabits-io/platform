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
export * from './errors';
export * from './create-app';
export * from './health';
export * from './request-scope';
export * from './bearer-auth';

// Backwards-compatible re-export: env config, response schemas, the swagger
// options builder, and the run/shutdown tail moved to the framework-agnostic
// `./server` module (they never imported Elysia). New code should import them
// from `@octabits-io/framework/server`.
export * from '../server/index';

// NOTE: the MCP harness lives at the `./mcp` subpath (not re-exported here) so
// the root export stays free of the optional `elysia-mcp` /
// `@modelcontextprotocol/sdk` peers. Import it via `@octabits-io/framework/elysia/mcp`.
//
// The test harness lives at the `./testing` subpath, also not re-exported: test
// helpers should not be reachable from production route code. Import it via
// `@octabits-io/framework/elysia/testing`.
