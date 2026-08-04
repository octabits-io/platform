/**
 * Security response-headers plugin.
 *
 * Sets the standard hardening headers on every response — including error
 * responses (thrown errors, 404s): the headers are staged in `onRequest`,
 * before routing and any handler, so they end up on whatever response Elysia
 * ultimately builds. The header map itself comes from the framework-neutral
 * `buildSecurityHeaders` (`../server/security-headers`), re-exported here for
 * backwards compatibility.
 */
import { Elysia } from 'elysia';
import { buildSecurityHeaders, type SecurityHeadersOptions } from '../server/security-headers';

export { buildSecurityHeaders };
export type { SecurityHeadersOptions };

export function createSecurityHeadersPlugin(options: SecurityHeadersOptions = {}) {
  const headers = buildSecurityHeaders(options);

  // `onRequest` runs before routing and before any handler/error path, and the
  // staged `set.headers` are applied to success AND error responses alike
  // (thrown errors, validation failures, and route-miss 404s included) —
  // unlike `onAfterHandle`, which never fires on error paths.
  return new Elysia({ name: 'security-headers' }).onRequest(({ set }) => {
    Object.assign(set.headers, headers);
  });
}
