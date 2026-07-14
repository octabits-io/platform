import { describe, expect, it } from 'vitest';
import { deepMerge } from './object.ts';

describe('deepMerge', () => {
  it('overrides leaf values', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it('merges nested objects recursively', () => {
    const base = { greeting: 'hi', common: { ok: 'OK', cancel: 'Cancel' } };
    const out = deepMerge(base, { common: { cancel: 'Abbrechen' } });
    expect(out).toEqual({ greeting: 'hi', common: { ok: 'OK', cancel: 'Abbrechen' } });
  });

  it('does not mutate the base', () => {
    const base = { common: { ok: 'OK' } };
    deepMerge(base, { common: { ok: 'Gut' } });
    expect(base.common.ok).toBe('OK');
  });

  it('replaces arrays wholesale (no concatenation)', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it('skips undefined override values, keeping the base', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: undefined })).toEqual({ a: 1, b: 2 });
  });

  it('models a register overlay (formal German over base de)', () => {
    const de = {
      greeting: 'Hallo {name},',
      linkHint: 'Oder kopiere diesen Link:',
      common: { reference: 'Buchungsreferenz', button: 'Anmelden' },
    };
    const formal = deepMerge(de, {
      greeting: 'Sehr geehrte(r) {name},',
      linkHint: 'Oder kopieren Sie diesen Link:',
    });
    expect(formal.greeting).toBe('Sehr geehrte(r) {name},');
    expect(formal.linkHint).toBe('Oder kopieren Sie diesen Link:');
    // inherited, register-invariant leaves stay identical to base
    expect(formal.common.reference).toBe('Buchungsreferenz');
    expect(formal.common.button).toBe('Anmelden');
  });
});
