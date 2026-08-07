/**
 * Typed `process.env` accessors and the CSV / CORS parse patterns. Pure
 * functions with no framework coupling — previously covered only through the
 * deleted Elysia suite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getEnv,
  getEnvOptional,
  getEnvNumber,
  getEnvNumberOptional,
  getEnvBoolean,
  isProduction,
  assertNotInProduction,
  parseCsv,
  parseCorsOrigins,
} from './config';

describe('config helpers', () => {
  const KEY = '__SERVER_CFG_TEST__';
  afterEach(() => { delete process.env[KEY]; delete process.env.PRODUCTION; delete process.env.NODE_ENV; });

  it('getEnv returns value, default, or throws', () => {
    process.env[KEY] = 'hi';
    expect(getEnv(KEY)).toBe('hi');
    expect(getEnv('__MISSING__', 'def')).toBe('def');
    expect(() => getEnv('__MISSING__')).toThrow(/Missing required/);
  });

  it('getEnvOptional / getEnvNumber / getEnvBoolean', () => {
    expect(getEnvOptional('__MISSING__')).toBeUndefined();
    process.env[KEY] = '42';
    expect(getEnvNumber(KEY, 7)).toBe(42);
    expect(getEnvNumber('__MISSING__', 7)).toBe(7);
    process.env[KEY] = 'TRUE';
    expect(getEnvBoolean(KEY, false)).toBe(true);
    process.env[KEY] = '1';
    expect(getEnvBoolean(KEY, false)).toBe(true);
    process.env[KEY] = 'no';
    expect(getEnvBoolean(KEY, true)).toBe(false);
  });

  it('getEnvNumber throws on garbage instead of returning NaN', () => {
    process.env[KEY] = 'not-a-number';
    expect(() => getEnvNumber(KEY, 7)).toThrow(/not a number/);
  });

  it('getEnvNumberOptional returns undefined on garbage or unset', () => {
    expect(getEnvNumberOptional('__MISSING__')).toBeUndefined();
    process.env[KEY] = 'not-a-number';
    expect(getEnvNumberOptional(KEY)).toBeUndefined();
    process.env[KEY] = '42';
    expect(getEnvNumberOptional(KEY)).toBe(42);
  });

  it('isProduction honors NODE_ENV and PRODUCTION', () => {
    expect(isProduction()).toBe(false);
    process.env.PRODUCTION = 'true';
    expect(isProduction()).toBe(true);
    delete process.env.PRODUCTION;
    process.env.NODE_ENV = 'production';
    expect(isProduction()).toBe(true);
  });

  it('assertNotInProduction is a no-op outside production', () => {
    process.env[KEY] = 'dev-only-secret';
    expect(() => assertNotInProduction(KEY)).not.toThrow();
    expect(() => assertNotInProduction(KEY, 'explicit-value')).not.toThrow();
    expect(() => assertNotInProduction(KEY, true)).not.toThrow();
  });

  it('assertNotInProduction throws in production when the env var is set', () => {
    process.env.NODE_ENV = 'production';
    process.env[KEY] = 'dev-only-secret';
    expect(() => assertNotInProduction(KEY)).toThrow(new RegExp(`${KEY} must not be set in production`));
  });

  it('assertNotInProduction honors PRODUCTION=true without NODE_ENV', () => {
    process.env.PRODUCTION = 'true';
    process.env[KEY] = 'x';
    expect(() => assertNotInProduction(KEY)).toThrow(/must not be set in production/);
  });

  it('assertNotInProduction passes in production when the value is unset', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertNotInProduction(KEY)).not.toThrow();
    process.env[KEY] = '';
    expect(() => assertNotInProduction(KEY)).not.toThrow(); // empty string is not "set"
  });

  it('assertNotInProduction checks an explicitly passed value over the env var', () => {
    process.env.NODE_ENV = 'production';
    // Env unset, but the caller already read a value from elsewhere → still throws.
    expect(() => assertNotInProduction(KEY, 'from-config')).toThrow(/must not be set in production/);
    // Env set, but the caller passes an explicitly-unset value → passes.
    process.env[KEY] = 'ignored';
    expect(() => assertNotInProduction(KEY, undefined)).toThrow(/must not be set in production/); // undefined → falls back to env
    expect(() => assertNotInProduction(KEY, false)).not.toThrow();
  });

  it('assertNotInProduction treats any non-empty string as set, including "false"', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertNotInProduction(KEY, 'false')).toThrow(/must not be set in production/);
  });

  it('parseCsv trims and drops empties; undefined → []', () => {
    expect(parseCsv('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv('')).toEqual([]);
  });

  it('parseCorsOrigins → list, or true when unset', () => {
    expect(parseCorsOrigins('https://a.com, https://b.com')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseCorsOrigins(undefined)).toBe(true);
  });
});
