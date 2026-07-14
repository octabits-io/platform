import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { de, en } from 'zod/locales';
import { setupZodLocaleSync } from './index.ts';

const invalidEmailMessage = () => {
  const result = z.string().email().safeParse('nope');
  return result.success ? '' : (result.error.issues[0]?.message ?? '');
};

describe('setupZodLocaleSync', () => {
  it('applies the active locale immediately and re-applies on change', () => {
    let trigger: (code: string) => void = () => {};
    setupZodLocaleSync({
      locales: { de, en },
      defaultLocale: 'en',
      getLocale: () => 'de',
      onLocaleChange: (apply) => {
        trigger = apply;
      },
    });
    const german = invalidEmailMessage();

    trigger('en');
    const english = invalidEmailMessage();

    expect(german).not.toBe(english);
    expect(german.length).toBeGreaterThan(0);
    expect(english.length).toBeGreaterThan(0);
  });

  it('falls back to the default locale for unknown codes', () => {
    setupZodLocaleSync({
      locales: { de, en },
      defaultLocale: 'en',
      getLocale: () => 'fr',
      onLocaleChange: () => {},
    });
    const viaFallback = invalidEmailMessage();

    z.config(en());
    expect(viaFallback).toBe(invalidEmailMessage());
  });
});
