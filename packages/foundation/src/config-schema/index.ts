// ============================================================================
// @octabits-io/foundation/config-schema
// ============================================================================
//
// Reusable Zod fragments for service-container config schemas. These are the
// sections that every backend container repeats verbatim — database pool knobs,
// structured logging / OTLP, and the ALTCHA captcha config — plus the two
// `nonEmptyString` / `nonEmptyUrl` primitives they are all built from.
//
// App-specific sections (storage, auth/OIDC field sets, domain config) stay in
// each app: they diverge per surface. Compose these fragments into the app's
// top-level `z.object({...})` and apply `.optional()` / `.extend(...)` as needed.

import { z } from 'zod';

/** A trimmed, non-empty string. Optional custom message. */
export const nonEmptyString = (message?: string) =>
  z.string().min(1, message || 'Value cannot be empty');

/** A non-empty, URL-formatted string. */
export const nonEmptyUrl = (message?: string) =>
  z.string().url().min(1);

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
  logger: z.coerce.boolean().default(false).optional(),
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
    enabled: z.coerce.boolean().default(defaultEnabled),
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
  consoleOutput: z.coerce.boolean().optional(),
});

// ----------------------------------------------------------------------------
// Captcha (ALTCHA)
// ----------------------------------------------------------------------------

/**
 * ALTCHA proof-of-work captcha config. Self-contained: already `.optional()`
 * and carries the "hmacSecret required when enabled" refinement, so consumers
 * use it directly as `captcha: CAPTCHA_CONFIG_SCHEMA`.
 */
export const CAPTCHA_CONFIG_SCHEMA = z.object({
  enabled: z.coerce.boolean().default(false),
  // Required when enabled. Min 32 chars. Used for both ALTCHA challenge signing
  // and the minted verified-token HMAC.
  hmacSecret: z.string().min(32).optional(),
  // PBKDF2 iteration count.
  cost: z.coerce.number().positive().optional(),
  // Challenge validity window in ms.
  expiresMs: z.coerce.number().positive().optional(),
  // Verified-token TTL after successful redeem.
  verifiedTokenTtlMs: z.coerce.number().positive().optional(),
}).optional().superRefine((data, ctx) => {
  if (data?.enabled && !data.hmacSecret) {
    ctx.addIssue({
      code: 'custom',
      message: 'captcha.hmacSecret is required when captcha.enabled',
      path: ['hmacSecret'],
    });
  }
});
