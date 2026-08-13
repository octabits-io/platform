/**
 * `@octabits-io/framework/hono` — reusable Hono middleware & helpers, the
 * package's HTTP glue module (thin replaceable glue over the framework-neutral
 * cores in `../server`, confinement enforced by the boundary lint). See
 * `docs/hono.md`.
 *
 * Deliberately NOT exported here (subpaths keep their optional peers out of
 * this barrel): `./hono/flow` (`octaflow`), `./hono/mcp`
 * (`@hono/mcp` + `@modelcontextprotocol/sdk`), `./hono/events` (the events
 * sub-app wrapper).
 */
export * from './request-scope';
export * from './bearer-auth';
export * from './errors';
export * from './security-headers';
export * from './client-ip';
export * from './rate-limit';
export * from './health';
export * from './create-app';
export * from './testing';
