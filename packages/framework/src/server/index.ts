// ============================================================================
// @octabits-io/framework/server — framework-agnostic server toolkit
// ============================================================================
//
// The parts of running an HTTP API that have nothing to do with the HTTP
// framework: typed env-config accessors, the `main()` run/shutdown tail
// (structural `.listen(port)` contract), the OpenAPI options builder
// (structural, no spec-generator dependency), and the standard zod response
// schemas. Nothing in this module imports an HTTP framework — that is enforced
// by `scripts/check-boundaries.mjs` (base tier).
//
// `./hono` wires these cores into Hono's hooks. Keeping the logic here is what
// let the Elysia→Hono swap be a rewrite of wiring files rather than a redesign.

export * from './config';
export * from './responses';
export * from './swagger';
export * from './run';
export * from './errors';
export * from './request-scope';
export * from './bearer-auth';
export * from './security-headers';
export * from './client-ip';
export * from './rate-limit';

// NOTE: the request-test harness lives at the `./server/testing` subpath, not
// re-exported here: test helpers should not be reachable from production route
// code. Import it via `@octabits-io/framework/server/testing`.
