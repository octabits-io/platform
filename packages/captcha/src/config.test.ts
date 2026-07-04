import { describe, it, expect } from 'vitest';
import { CAPTCHA_CONFIG_SCHEMA } from './config';

describe('CAPTCHA_CONFIG_SCHEMA', () => {
  it('accepts an absent config (optional)', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it('defaults enabled to false', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.enabled).toBe(false);
  });

  it('accepts a disabled config without an hmacSecret', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it('rejects an enabled config without an hmacSecret', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['hmacSecret']);
  });

  it('rejects an hmacSecret shorter than 32 chars', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse({ enabled: true, hmacSecret: 'tooshort' });
    expect(result.success).toBe(false);
  });

  it('accepts an enabled config with a valid hmacSecret and coerces numeric knobs', () => {
    const result = CAPTCHA_CONFIG_SCHEMA.safeParse({
      enabled: true,
      hmacSecret: '0123456789abcdef0123456789abcdef',
      cost: '50000',
      expiresMs: '600000',
      verifiedTokenTtlMs: '1200000',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.cost).toBe(50000);
    expect(result.data?.expiresMs).toBe(600000);
    expect(result.data?.verifiedTokenTtlMs).toBe(1200000);
  });
});
