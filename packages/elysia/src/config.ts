/**
 * Typed `process.env` accessors plus the CSV / CORS parse patterns every API
 * config file repeats. Pure — no Elysia dependency; co-located here because these
 * feed the middleware in this package (trusted proxies → client-ip, CIDRs →
 * rate-limit, origins → CORS).
 */

/** Required env var — returns `defaultValue` if unset, throws if neither is present. */
export function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Optional env var → its value or `undefined`. */
export function getEnvOptional(key: string): string | undefined {
  return process.env[key];
}

/** Integer env var with a default. */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

/** Optional integer env var → its parsed value or `undefined`. */
export function getEnvNumberOptional(key: string): number | undefined {
  const value = process.env[key];
  return value ? parseInt(value, 10) : undefined;
}

/** Boolean env var (`'true'`/`'1'` → true) with a default. */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/** `NODE_ENV === 'production'` OR `PRODUCTION` truthy. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || getEnvBoolean('PRODUCTION', false);
}

/**
 * Comma-split → trim → drop empties. Undefined/empty → `[]`.
 * For `TRUSTED_PROXIES`, `RATE_LIMIT_SKIP_CIDRS`, and similar list env vars.
 */
export function parseCsv(value: string | undefined): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * CORS origins: comma-split → trimmed list, or `true` (allow-all) when unset.
 * Mirrors the `CORS_ORIGINS` pattern (note: no empty-filtering, matching the
 * original behavior). Apps that must reject a wildcard in production should
 * guard on `value` being set before calling this.
 */
export function parseCorsOrigins(value: string | undefined): string[] | true {
  return value ? value.split(',').map((s) => s.trim()) : true;
}
