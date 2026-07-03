import { describe, it, expect } from 'vitest';
import {
  nonEmptyString,
  nonEmptyUrl,
  DATABASE_CONFIG_SCHEMA,
  createRlsSchema,
  LOGGING_CONFIG_SCHEMA,
  CAPTCHA_CONFIG_SCHEMA,
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

describe('CAPTCHA_CONFIG_SCHEMA', () => {
  it('is optional', () => {
    expect(CAPTCHA_CONFIG_SCHEMA.safeParse(undefined).success).toBe(true);
  });

  it('requires hmacSecret (min 32) when enabled', () => {
    expect(CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: true }).success).toBe(false);
    expect(CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: true, hmacSecret: 'short' }).success).toBe(false);
    expect(CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: true, hmacSecret: 'x'.repeat(32) }).success).toBe(true);
  });

  it('allows disabled with no secret', () => {
    expect(CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: false }).success).toBe(true);
  });
});
