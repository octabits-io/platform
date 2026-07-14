/**
 * App config: `process.env` → a validated, typed object.
 *
 * Showcases `@octabits-io/framework/config-schema` (reusable Zod fragments) and
 * `@octabits-io/framework/elysia`'s env accessors (`getEnv*`, `parseCsv`,
 * `isProduction`). The framework ships the fragments that every backend repeats
 * verbatim (database pool knobs, structured logging); app-specific sections
 * (PII keys, mail identity) stay here.
 */
import { z } from 'zod';
import {
  DATABASE_CONFIG_SCHEMA,
  LOGGING_CONFIG_SCHEMA,
  MAIL_CONFIG_SCHEMA,
  booleanFromEnv,
  createConfigParser,
  nonEmptyString,
  nonEmptyUrl,
} from '@octabits-io/framework/config-schema';
import {
  assertNotInProduction,
  getEnv,
  getEnvNumber,
  isProduction,
  parseCsv,
} from '@octabits-io/framework/elysia';
import { MIN_BLIND_INDEX_KEY_LENGTH } from '@octabits-io/framework/pii';

/**
 * Well-known DEV key material, committed on purpose so `docker compose up` +
 * `bun dev` works with zero setup. `loadConfig` refuses to boot with these when
 * `NODE_ENV=production` — the same fail-closed shape `nuxt-ui-kit`'s
 * `seedAuthBypassSession` uses for its auth bypass.
 */
const DEV_AGE_IDENTITY =
  'AGE-SECRET-KEY-10ESX7NTKP6T2Z2DNW85R44PGPX0TR46N9J4YZXNR02J5MFAHY29SW92RCH';
const DEV_BLIND_INDEX_KEY = 'demo-blind-index-key-not-for-production-use';

const SCHEMA_CONFIG = z.object({
  port: z.coerce.number().int().positive(),
  /** Absolute base URL this API is reachable at — used to build blob public URLs. */
  publicBaseUrl: nonEmptyUrl(),
  database: DATABASE_CONFIG_SCHEMA,
  logging: LOGGING_CONFIG_SCHEMA,
  pii: z.object({
    /** Age identity (AGE-SECRET-KEY-1…). Its recipient is derived at boot. */
    ageIdentity: nonEmptyString('DEMO_AGE_IDENTITY cannot be empty'),
    /** HMAC key behind the searchable-email blind index. */
    blindIndexKey: z.string().min(MIN_BLIND_INDEX_KEY_LENGTH),
  }),
  /**
   * The framework's mail fragment: a discriminated union on `mode` over the
   * four shipped transports, plus the platform-identity fields
   * (`platformFromAddress`, `platformFromName`, …) named to spread straight
   * into `createBaseMailService`. This demo only wires the logger transport,
   * so `loadConfig` rejects other modes with a pointer instead of failing
   * later in the transport factory.
   */
  mail: MAIL_CONFIG_SCHEMA,
  enableSwagger: z.boolean(),
  rateLimit: z.object({
    max: z.coerce.number().int().positive(),
    windowMs: z.coerce.number().int().positive(),
  }),
  /** X-Forwarded-For trust list. Empty = trust nobody (clientIp = socket peer). */
  trustedProxies: z.array(z.string()),
  /**
   * Browser origins allowed to call this API. The SPA (`apps/demo-web`) is a
   * different origin than the API, so without this every request from it dies
   * in preflight — curl never notices, which is exactly how this stayed
   * unwired until a browser first tried.
   */
  corsOrigins: z.array(z.string()),
});

export type AppConfig = z.infer<typeof SCHEMA_CONFIG>;

/**
 * `createConfigParser` wraps `safeParse` into a `Result` with a stable
 * `config_invalid` key and every issue path aggregated into one message —
 * boot code throws that message once instead of a raw ZodError.
 */
const parseConfig = createConfigParser(SCHEMA_CONFIG);

/** Parse + validate the environment. Throws on a misconfigured environment. */
export function loadConfig(): AppConfig {
  const ageIdentity = getEnv('DEMO_AGE_IDENTITY', DEV_AGE_IDENTITY);
  const blindIndexKey = getEnv('DEMO_BLIND_INDEX_KEY', DEV_BLIND_INDEX_KEY);

  // `assertNotInProduction` throws when the flag is truthy AND NODE_ENV is
  // production — the presence-flag here is "the committed dev key material is
  // in use", i.e. neither env var was set.
  assertNotInProduction(
    'committed demo PII keys (set DEMO_AGE_IDENTITY and DEMO_BLIND_INDEX_KEY)',
    ageIdentity === DEV_AGE_IDENTITY || blindIndexKey === DEV_BLIND_INDEX_KEY,
  );

  const parsed = parseConfig({
    port: getEnvNumber('PORT', 3001),
    publicBaseUrl: getEnv('PUBLIC_BASE_URL', 'http://localhost:3001'),
    database: {
      url: getEnv('DATABASE_URL', 'postgres://demo:demo@localhost:5433/demo'),
    },
    logging: {
      level: getEnv('LOG_LEVEL', 'debug'),
      environment: getEnv('NODE_ENV', 'development'),
    },
    pii: { ageIdentity, blindIndexKey },
    mail: {
      mode: getEnv('MAIL_MODE', 'logger'),
      platformFromAddress: getEnv('MAIL_FROM_ADDRESS', 'noreply@demo.example'),
      // The platform *brand*. The mail service composes the platform-fallback
      // From as "<scopeName> via <brand>" — see services/mail.ts.
      platformFromName: getEnv('MAIL_FROM_NAME', 'Octabits Demo'),
    },
    enableSwagger: booleanFromEnv().parse(getEnv('ENABLE_SWAGGER', isProduction() ? 'false' : 'true')),
    rateLimit: {
      max: getEnvNumber('RATE_LIMIT_MAX', 200),
      windowMs: getEnvNumber('RATE_LIMIT_WINDOW_MS', 60_000),
    },
    trustedProxies: parseCsv(process.env.TRUSTED_PROXIES),
    // Defaults to the demo SPA's dev origin (nuxt.config.ts pins port 3100).
    corsOrigins: parseCsv(process.env.CORS_ORIGINS ?? 'http://localhost:3100'),
  });
  if (!parsed.ok) throw new Error(parsed.error.message);

  if (parsed.value.mail.mode !== 'logger') {
    throw new Error(
      `MAIL_MODE '${parsed.value.mail.mode}' is valid config, but this demo only wires the logger transport — see services/mail.ts for where smtp/mailjet/brevo would slot in.`,
    );
  }

  return parsed.value;
}
