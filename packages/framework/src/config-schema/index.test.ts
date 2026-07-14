import { describe, it, expect } from 'vitest';
import {
  nonEmptyString,
  nonEmptyUrl,
  booleanFromEnv,
  DATABASE_CONFIG_SCHEMA,
  createRlsSchema,
  LOGGING_CONFIG_SCHEMA,
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
