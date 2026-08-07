// Transport-agnostic API-client seams (base URL + OIDC bearer)
export { createAccessTokenProvider, resolveApiBaseUrl } from './client.ts';
export type { ResolveApiBaseUrlOptions } from './client.ts';
