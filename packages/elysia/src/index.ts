// ============================================================================
// @octabits-io/elysia — reusable Elysia middleware & helpers
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
