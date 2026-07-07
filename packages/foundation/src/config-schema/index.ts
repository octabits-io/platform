// ============================================================================
// @octabits-io/foundation/config-schema
// ============================================================================
//
// Reusable Zod fragments for service-container config schemas. These are the
// sections that every backend container repeats verbatim — database pool knobs
// and structured logging / OTLP — plus the two `nonEmptyString` / `nonEmptyUrl`
// primitives they are all built from.
//
// App-specific sections (storage, auth/OIDC field sets, captcha, domain config)
// stay in each app: they diverge per surface or encode a product choice.
// Compose these fragments into the app's top-level `z.object({...})` and apply
// `.optional()` / `.extend(...)` as needed.

import { z } from 'zod';

/** A trimmed, non-empty string. Optional custom message. */
export const nonEmptyString = (message?: string) =>
  z.string().min(1, message || 'Value cannot be empty');

/** A non-empty, URL-formatted string. Optional custom message. */
export const nonEmptyUrl = (message?: string) =>
  z.url(message || 'Value must be a valid URL');

/**
 * Boolean that also accepts common env-var string spellings. Booleans pass
 * through; strings map (case-insensitively) `'true'`/`'1'` → `true` and
 * `'false'`/`'0'`/`''` → `false`. Anything else fails validation — unlike
 * `z.coerce.boolean()`, which treats every non-empty string ("false", "0")
 * as `true`.
 */
export const booleanFromEnv = () =>
  z.union([z.boolean(), z.string()]).transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0' || normalized === '') return false;
    ctx.addIssue({ code: 'custom', message: `Invalid boolean value: "${value}"` });
    return z.NEVER;
  });

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------

/**
 * Common database connection + pool config. RLS is intentionally NOT included:
 * it is surface-specific (operator defaults it off, customer defaults it on,
 * public omits it entirely), so consumers `.extend({ rls: ... })` themselves.
 */
export const DATABASE_CONFIG_SCHEMA = z.object({
  url: nonEmptyUrl(),
  /** Optional direct (non-PgBouncer) URL used by pg-boss + migrations.
   *  pg-boss uses LISTEN/NOTIFY and named prepared statements which break
   *  under PgBouncer transaction-pool mode; migrations need persistent
   *  state across DDL statements. Falls back to `url` when omitted. */
  directUrl: nonEmptyUrl().optional(),
  logger: booleanFromEnv().default(false).optional(),
  /** pg.Pool max connections. Defaults to 20. */
  poolMaxConnections: z.coerce.number().int().positive().optional(),
  /** Idle pool client eviction (ms). Defaults to 30s. */
  poolIdleTimeoutMs: z.coerce.number().int().nonnegative().optional(),
  /** Max time to wait for a pool connection (ms). Defaults to 5s. */
  poolConnectionTimeoutMs: z.coerce.number().int().nonnegative().optional(),
  /** Server-enforced statement timeout (ms). 0 disables. Defaults to 30s. */
  statementTimeoutMs: z.coerce.number().int().nonnegative().optional(),
});

/**
 * RLS toggle fragment. `defaultEnabled` sets the per-surface default:
 * operator → `false`, customer → `true`. Public omits RLS config entirely.
 */
export const createRlsSchema = (defaultEnabled: boolean) =>
  z.object({
    enabled: booleanFromEnv().default(defaultEnabled),
  }).optional();

// ----------------------------------------------------------------------------
// Logging
// ----------------------------------------------------------------------------

/**
 * Structured logging + optional OTLP export. Consumers apply `.optional()`
 * (logging config is omittable in every container).
 */
export const LOGGING_CONFIG_SCHEMA = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  environment: z.string().optional(),
  otlp: z.object({
    endpoint: nonEmptyUrl(),
    headers: z.record(z.string(), z.string()).optional(),
  }).optional(),
  consoleOutput: booleanFromEnv().optional(),
});
