// ============================================================================
// @octabits-io/framework/config-schema
// ============================================================================
//
// Reusable Zod fragments for service-container config schemas. These are the
// sections that every backend container repeats verbatim — database pool knobs,
// structured logging / OTLP, and mail transport selection — plus the
// `nonEmptyString` / `nonEmptyUrl` / `booleanFromEnv` primitives they are all
// built from, and `createConfigParser` to turn a composed schema into a
// `Result`-returning parser.
//
// App-specific sections (storage, auth/OIDC field sets, captcha, domain config)
// stay in each app: they diverge per surface or encode a product choice.
// Compose these fragments into the app's top-level `z.object({...})` and apply
// `.optional()` / `.extend(...)` as needed.

import { z } from 'zod';
import { type OctError, type Result, ok, err } from '../result/index.ts';

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

// ----------------------------------------------------------------------------
// Mail
// ----------------------------------------------------------------------------

/**
 * Fields every mail mode carries — the platform sender identity plus the two
 * delivery-safety switches `@octabits-io/framework/mail`'s
 * `createBaseMailService` reads (`forceNotificationsOnlyDelivery`,
 * `devOverrideRecipient`). Field names match that service's config so a parsed
 * section can be spread straight into it.
 */
const mailSharedFields = {
  /** From address for the platform transport (dev/test + platform fallback). */
  platformFromAddress: nonEmptyString('Platform From address cannot be empty'),
  /** From display name for the platform transport. */
  platformFromName: nonEmptyString('Platform From name cannot be empty').optional(),
  /**
   * Platform-level address for system/admin notifications. Optional: a consumer
   * whose notification recipients are resolved per scope (via the mail service's
   * `configReader`) has no platform-level fallback to declare.
   */
  platformNotificationsAddress: z.email('Platform notifications address must be a valid email').optional(),
  /** Force `notifications_only` for all user mail. */
  forceNotificationsOnlyDelivery: booleanFromEnv().optional(),
  /** Dev-only override: redirect every outgoing mail to this address. */
  devOverrideRecipient: z.email('Dev override recipient must be a valid email').optional(),
};

/**
 * Mail transport selection + credentials, discriminated on `mode`:
 *
 * - `logger` — no credentials; pairs with the logger/in-memory transports the
 *   `@octabits-io/framework/mail` root ships for dev/tests.
 * - `smtp` / `mailjet` / `brevo` — the vendor sections behind `./mail/smtp`,
 *   `./mail/mailjet`, and `./mail/brevo`.
 *
 * Every mode also carries the shared platform-identity + delivery-safety fields
 * (see {@link mailSharedFields}) — including `logger`, so flipping `mode` in an
 * env file never invalidates the rest of the section.
 *
 * Booleans go through `booleanFromEnv()` rather than `z.coerce.boolean()`:
 * `MAIL_SECURE=false` must mean `false`.
 */
export const MAIL_CONFIG_SCHEMA = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('logger'),
    ...mailSharedFields,
  }),
  z.object({
    mode: z.literal('smtp'),
    host: nonEmptyString('SMTP host cannot be empty'),
    port: z.coerce.number().int().positive('SMTP port must be a positive number'),
    secure: booleanFromEnv().default(false),
    user: nonEmptyString('SMTP user cannot be empty'),
    password: nonEmptyString('SMTP password cannot be empty'),
    ...mailSharedFields,
  }),
  z.object({
    mode: z.literal('mailjet'),
    apiKey: nonEmptyString('Mailjet API key cannot be empty'),
    apiSecret: nonEmptyString('Mailjet API secret cannot be empty'),
    ...mailSharedFields,
  }),
  z.object({
    mode: z.literal('brevo'),
    apiKey: nonEmptyString('Brevo API key cannot be empty'),
    ...mailSharedFields,
  }),
]);

/** The parsed mail section — discriminated on `mode`. */
export type MailConfig = z.infer<typeof MAIL_CONFIG_SCHEMA>;

// ----------------------------------------------------------------------------
// Parsing
// ----------------------------------------------------------------------------

/** A config object that failed its schema. `message` lists the offending paths. */
export interface ConfigInvalidError extends OctError {
  key: 'config_invalid';
}

/**
 * Wrap a config schema into a `Result`-returning parser — the Result-pattern
 * counterpart to `schema.parse` (which throws) and `schema.safeParse` (whose
 * `ZodError` is not an `OctError`). Every container repeats this shape; build it
 * once next to the schema and export the parser:
 *
 * ```ts
 * export const APP_CONFIG_SCHEMA = z.object({ database: DATABASE_CONFIG_SCHEMA });
 * export type AppConfig = z.infer<typeof APP_CONFIG_SCHEMA>;
 * export const parseAppConfig = createConfigParser(APP_CONFIG_SCHEMA);
 *
 * const parsed = parseAppConfig(raw);
 * if (!parsed.ok) throw new Error(parsed.error.message); // boot-time: fail loud
 * ```
 *
 * The error message aggregates every issue as `path: message` (dotted paths,
 * `<root>` for a top-level issue), so one parse reports all problems rather
 * than only the first. Values are never echoed — a config section holds
 * secrets, and this message is expected to reach logs.
 */
export function createConfigParser<S extends z.ZodType>(
  schema: S,
): (input: unknown) => Result<z.infer<S>, ConfigInvalidError> {
  return (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return ok(parsed.data as z.infer<S>);

    const details = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('; ');
    return err({ key: 'config_invalid', message: `Invalid config — ${details}` });
  };
}
