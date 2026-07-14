import { describe, expect, it } from 'vitest';
import { stripDefaults } from './stripDefaults.ts';

describe('stripDefaults', () => {
  it('omits empty strings, null, and undefined', () => {
    const defaults = { a: '', b: '', c: '' };
    const state = { a: 'hello', b: '', c: undefined as unknown as string };
    expect(stripDefaults(state, defaults)).toEqual({ a: 'hello' });
  });

  it('omits empty arrays', () => {
    const defaults = { items: [] as string[] };
    const state = { items: [] as string[] };
    expect(stripDefaults(state, defaults)).toEqual({});
  });

  it('keeps populated arrays', () => {
    const defaults = { items: [] as string[] };
    const state = { items: ['a', 'b'] };
    expect(stripDefaults(state, defaults)).toEqual({ items: ['a', 'b'] });
  });

  it('omits values referentially equal to the default', () => {
    const sharedDefault = { nested: true };
    const defaults = { config: sharedDefault };
    const state = { config: sharedDefault };
    expect(stripDefaults(state, defaults)).toEqual({});
  });

  it('keeps values that differ from the default', () => {
    const defaults = { config: { nested: true } };
    const state = { config: { nested: false } };
    expect(stripDefaults(state, defaults)).toEqual({ config: { nested: false } });
  });

  it('honors alwaysEmit for empty strings', () => {
    const defaults = { buttonText: '' };
    const state = { buttonText: '' };
    expect(stripDefaults(state, defaults, { alwaysEmit: ['buttonText'] })).toEqual({
      buttonText: '',
    });
  });

  it('honors alwaysEmit even when value equals the default', () => {
    const defaults = { captchaEnabled: true };
    const state = { captchaEnabled: true };
    expect(stripDefaults(state, defaults, { alwaysEmit: ['captchaEnabled'] })).toEqual({
      captchaEnabled: true,
    });
  });

  it('preserves zero and false as non-empty values', () => {
    const defaults = { count: -1, enabled: true };
    const state = { count: 0, enabled: false };
    expect(stripDefaults(state, defaults)).toEqual({ count: 0, enabled: false });
  });

  it('returns {} when state matches all defaults', () => {
    const defaults = { a: '', b: 0, c: [] as string[] };
    const state = { a: '', b: 0, c: [] as string[] };
    // b=0 !== defaults.b=0 only if defaults.b is a distinct reference; with primitives, === holds
    expect(stripDefaults(state, defaults)).toEqual({});
  });
});
