import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  nonEmptyString,
  nonEmptyUrl,
  booleanFromEnv,
  DATABASE_CONFIG_SCHEMA,
  createRlsSchema,
  LOGGING_CONFIG_SCHEMA,
  MAIL_CONFIG_SCHEMA,
  createConfigParser,
} from './index';

describe('nonEmptyString / nonEmptyUrl', () => {
  it('rejects empty strings', () => {
    expect(nonEmptyString().safeParse('').success).toBe(false);
    expect(nonEmptyString().safeParse('x').success).toBe(true);
  });

  it('requires URL format', () => {
    expect(nonEmptyUrl().safeParse('not-a-url').success).toBe(false);
    expect(nonEmptyUrl().safeParse('https://a.com').success).toBe(true);
  });

  it('wires the custom message through', () => {
    const parsed = nonEmptyUrl('custom url message').safeParse('not-a-url');
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('custom url message');
    }
  });
});

describe('booleanFromEnv', () => {
  it('passes booleans through as-is', () => {
    expect(booleanFromEnv().parse(true)).toBe(true);
    expect(booleanFromEnv().parse(false)).toBe(false);
  });

  it('parses truthy env spellings', () => {
    expect(booleanFromEnv().parse('true')).toBe(true);
    expect(booleanFromEnv().parse('TRUE')).toBe(true);
    expect(booleanFromEnv().parse('1')).toBe(true);
  });

  it('parses "false", "0", and "" as false (regression: z.coerce.boolean made these true)', () => {
    expect(booleanFromEnv().parse('false')).toBe(false);
    expect(booleanFromEnv().parse('FALSE')).toBe(false);
    expect(booleanFromEnv().parse('0')).toBe(false);
    expect(booleanFromEnv().parse('')).toBe(false);
  });

  it('rejects other strings and non-string/boolean input', () => {
    expect(booleanFromEnv().safeParse('yes').success).toBe(false);
    expect(booleanFromEnv().safeParse('2').success).toBe(false);
    expect(booleanFromEnv().safeParse(1).success).toBe(false);
  });
});

describe('DATABASE_CONFIG_SCHEMA', () => {
  it('requires url and defaults logger off', () => {
    const parsed = DATABASE_CONFIG_SCHEMA.safeParse({ url: 'postgres://x/db' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.logger).toBe(false);
  });

  it('rejects a missing url', () => {
    expect(DATABASE_CONFIG_SCHEMA.safeParse({}).success).toBe(false);
  });

  it('coerces numeric pool knobs', () => {
    const parsed = DATABASE_CONFIG_SCHEMA.safeParse({ url: 'postgres://x/db', poolMaxConnections: '20' });
    expect(parsed.success && parsed.data.poolMaxConnections).toBe(20);
  });

  it('treats logger: "false" and "0" as false', () => {
    for (const raw of ['false', '0']) {
      const parsed = DATABASE_CONFIG_SCHEMA.safeParse({ url: 'postgres://x/db', logger: raw });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.logger).toBe(false);
    }
    const truthy = DATABASE_CONFIG_SCHEMA.safeParse({ url: 'postgres://x/db', logger: 'true' });
    expect(truthy.success && truthy.data.logger).toBe(true);
  });
});

describe('createRlsSchema', () => {
  it('applies the per-surface default', () => {
    expect(createRlsSchema(false).parse({})).toEqual({ enabled: false });
    expect(createRlsSchema(true).parse({})).toEqual({ enabled: true });
    expect(createRlsSchema(true).parse(undefined)).toBeUndefined();
  });

  it('composes onto the base database schema via .extend', () => {
    const operatorDb = DATABASE_CONFIG_SCHEMA.extend({ rls: createRlsSchema(false) });
    const parsed = operatorDb.safeParse({ url: 'postgres://x/db' });
    expect(parsed.success).toBe(true);
  });
});

describe('LOGGING_CONFIG_SCHEMA', () => {
  it('defaults level to info', () => {
    const parsed = LOGGING_CONFIG_SCHEMA.safeParse({});
    expect(parsed.success && parsed.data.level).toBe('info');
  });

  it('validates the otlp endpoint as a url', () => {
    expect(LOGGING_CONFIG_SCHEMA.safeParse({ otlp: { endpoint: 'nope' } }).success).toBe(false);
    expect(LOGGING_CONFIG_SCHEMA.safeParse({ otlp: { endpoint: 'https://c.io' } }).success).toBe(true);
  });
});

describe('MAIL_CONFIG_SCHEMA', () => {
  const identity = { platformFromAddress: 'noreply@example.com' };

  it('accepts a logger config with only the platform identity', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({ mode: 'logger', ...identity });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mode).toBe('logger');
  });

  it('accepts an smtp config and defaults secure to false', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({
      mode: 'smtp',
      host: 'smtp.example.com',
      port: '587',
      user: 'mailer',
      password: 's3cret',
      ...identity,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.mode === 'smtp') {
      expect(parsed.data.port).toBe(587); // coerced from the env string
      expect(parsed.data.secure).toBe(false);
    }
  });

  it('accepts a mailjet config', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({
      mode: 'mailjet',
      apiKey: 'mj-key',
      apiSecret: 'mj-secret',
      ...identity,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a brevo config', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({ mode: 'brevo', apiKey: 'bv-key', ...identity });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(MAIL_CONFIG_SCHEMA.safeParse({ mode: 'carrier-pigeon', ...identity }).success).toBe(false);
  });

  it('rejects a mode whose credentials are missing', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({ mode: 'brevo', ...identity });
    expect(parsed.success).toBe(false);
  });

  it('requires the platform From address in every mode', () => {
    expect(MAIL_CONFIG_SCHEMA.safeParse({ mode: 'logger' }).success).toBe(false);
    expect(MAIL_CONFIG_SCHEMA.safeParse({ mode: 'logger', platformFromAddress: '' }).success).toBe(false);
  });

  it('validates the optional email fields', () => {
    expect(
      MAIL_CONFIG_SCHEMA.safeParse({ mode: 'logger', ...identity, devOverrideRecipient: 'nope' }).success,
    ).toBe(false);
    expect(
      MAIL_CONFIG_SCHEMA.safeParse({ mode: 'logger', ...identity, platformNotificationsAddress: 'nope' }).success,
    ).toBe(false);
    expect(
      MAIL_CONFIG_SCHEMA.safeParse({
        mode: 'logger',
        ...identity,
        devOverrideRecipient: 'dev@example.com',
        platformNotificationsAddress: 'ops@example.com',
      }).success,
    ).toBe(true);
  });

  it('reads booleans via booleanFromEnv, not z.coerce.boolean (regression: "false" must be false)', () => {
    const parsed = MAIL_CONFIG_SCHEMA.safeParse({
      mode: 'smtp',
      host: 'smtp.example.com',
      port: 465,
      secure: 'false',
      user: 'mailer',
      password: 's3cret',
      forceNotificationsOnlyDelivery: 'false',
      ...identity,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.mode === 'smtp') {
      expect(parsed.data.secure).toBe(false);
      expect(parsed.data.forceNotificationsOnlyDelivery).toBe(false);
    }
  });
});

describe('createConfigParser', () => {
  const schema = z.object({
    database: DATABASE_CONFIG_SCHEMA,
    mail: MAIL_CONFIG_SCHEMA.optional(),
  });

  it('returns ok with the parsed (defaulted, coerced) value', () => {
    const parse = createConfigParser(schema);
    const result = parse({ database: { url: 'postgres://x/db', poolMaxConnections: '20' } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.database.url).toBe('postgres://x/db');
      expect(result.value.database.poolMaxConnections).toBe(20);
      expect(result.value.database.logger).toBe(false);
    }
  });

  it('returns err config_invalid with the dotted issue path', () => {
    const parse = createConfigParser(schema);
    const result = parse({ database: { url: 'not-a-url' } });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('config_invalid');
      expect(result.error.message).toContain('database.url');
    }
  });

  it('aggregates every issue, not just the first', () => {
    const parse = createConfigParser(schema);
    const result = parse({
      database: { url: 'not-a-url', poolMaxConnections: 'many' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('database.url');
      expect(result.error.message).toContain('database.poolMaxConnections');
    }
  });

  it('labels a top-level issue <root>', () => {
    const parse = createConfigParser(schema);
    const result = parse('not-an-object');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('<root>');
  });

  it('does not echo config values into the message (they hold secrets)', () => {
    const parse = createConfigParser(z.object({ apiKey: z.string().min(10) }));
    const result = parse({ apiKey: 'sh0rt' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain('sh0rt');
  });
});
