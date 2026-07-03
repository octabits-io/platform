// ============================================================================
// @octabits-io/elysia — reusable Elysia middleware & helpers
// ============================================================================
//
// Security headers, trusted-proxy client IP, error mapping + the ApiError family,
// and standard response schemas. Provider/domain-agnostic: keyed errors are just
// `{ key, message }`, and domain key→status rules are injected via `statusOverrides`.

export * from './security-headers';
export * from './client-ip';
export * from './responses';
export * from './errors';
