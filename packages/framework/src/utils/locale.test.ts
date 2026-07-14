import { describe, expect, it } from 'vitest';
import type { LocaleMap } from './locale.ts';
import {
  BCP47_LOCALE_REGEX,
  anyLocaleValue,
  baseLocaleOf,
  isLocaleMap,
  isLocaleMapComplete,
  localeFallbackChain,
  matchLocaleTag,
  missingLocales,
  negotiateContentLocale,
  parseAcceptLanguage,
  resolveLocale,
  resolveLocaleDeep,
  resolveLocaleOrAny,
  resolveLocaleStrict,
} from './locale.ts';

describe('BCP47_LOCALE_REGEX', () => {
  it.each([
    'en',
    'de',
    'fr',
    'zh-Hans',
    'fr-CA',
    'de-formal',
    'de-AT',
    'zh-Hans-CN',
    'en-US',
    // UN M49 numeric region subtags.
    'es-419',
    'en-001',
    // Numeric-leading BCP-47 variant subtag.
    'de-CH-1901',
  ])('accepts valid tag %s', (tag) => {
    expect(BCP47_LOCALE_REGEX.test(tag)).toBe(true);
  });

  it.each([
    '',
    'EN', // uppercase language subtag deliberately rejected
    'e',
    'english',
    'en_US',
    '123',
    'x-',
    'toolong-abc',
  ])('rejects invalid tag %s', (tag) => {
    expect(BCP47_LOCALE_REGEX.test(tag)).toBe(false);
  });
});

describe('baseLocaleOf', () => {
  it.each([
    ['de-formal', 'de'],
    ['de-DE', 'de'],
    ['fr-CA', 'fr'],
    ['zh-Hans-CN', 'zh'],
    ['de', 'de'],
    ['EN', 'en'],
  ])('narrows %s to %s', (input, expected) => {
    expect(baseLocaleOf(input)).toBe(expected);
  });
});

describe('matchLocaleTag', () => {
  it('matches an exact tag', () => {
    expect(matchLocaleTag('de', ['en', 'de'])).toBe('de');
  });

  it('is case-insensitive on the exact match', () => {
    expect(matchLocaleTag('DE', ['en', 'de'])).toBe('de');
  });

  it('falls back to a base-language match (route de → supported de-formal)', () => {
    expect(matchLocaleTag('de', ['en', 'de-formal'])).toBe('de-formal');
  });

  it('matches a region tag against the base supported locale (de-AT → de)', () => {
    expect(matchLocaleTag('de-AT', ['en', 'de'])).toBe('de');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchLocaleTag('fr', ['en', 'de'])).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(matchLocaleTag(null, ['en'])).toBeUndefined();
    expect(matchLocaleTag('', ['en'])).toBeUndefined();
  });
});

describe('parseAcceptLanguage', () => {
  it('orders tags by descending quality', () => {
    expect(parseAcceptLanguage('en;q=0.5,de;q=0.9,fr')).toEqual(['fr', 'de', 'en']);
  });

  it('drops the wildcard and blanks', () => {
    expect(parseAcceptLanguage('*,de')).toEqual(['de']);
  });

  it('returns empty for missing header', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });

  it('treats a malformed q-value as 1 instead of sorting NaN to the top', () => {
    // `en;q=bad` and `en;q=` default to q=1; `de;q=0.9` stays below them.
    expect(parseAcceptLanguage('en;q=bad,de;q=0.9')).toEqual(['en', 'de']);
    expect(parseAcceptLanguage('en;q=,de;q=0.9')).toEqual(['en', 'de']);
  });

  it('drops entries explicitly marked not-acceptable (q=0)', () => {
    expect(parseAcceptLanguage('de;q=0,en;q=0.5')).toEqual(['en']);
    expect(parseAcceptLanguage('de;q=0.0,fr;q=-1,en')).toEqual(['en']);
  });

  it('clamps out-of-range q-values into [0,1]', () => {
    // q=5 clamps to 1 (ties with the default-1 `fr`), q=-2 drops out.
    expect(parseAcceptLanguage('de;q=5,fr,it;q=-2')).toEqual(['de', 'fr']);
  });
});

describe('negotiateContentLocale', () => {
  const supported = ['en', 'de-formal'];

  it('prefers an explicit hint, matched by base language', () => {
    expect(
      negotiateContentLocale({ hint: 'de', supported, defaultLocale: 'en' }),
    ).toBe('de-formal');
  });

  it('falls back to Accept-Language when no hint matches', () => {
    expect(
      negotiateContentLocale({
        hint: 'fr',
        acceptLanguage: 'de-DE,en;q=0.5',
        supported,
        defaultLocale: 'en',
      }),
    ).toBe('de-formal');
  });

  it('falls back to the tenant default when nothing matches', () => {
    expect(
      negotiateContentLocale({
        hint: 'it',
        acceptLanguage: 'pt,ja;q=0.5',
        supported,
        defaultLocale: 'en',
      }),
    ).toBe('en');
  });
});

describe('localeFallbackChain', () => {
  it('expands a register variant to base then default', () => {
    expect(localeFallbackChain('de-formal', 'en')).toEqual(['de-formal', 'de', 'en']);
  });

  it('de-duplicates when locale equals its base', () => {
    expect(localeFallbackChain('de', 'en')).toEqual(['de', 'en']);
  });

  it('de-duplicates when locale equals default', () => {
    expect(localeFallbackChain('en', 'en')).toEqual(['en']);
  });

  it('includes the default base for a variant default', () => {
    expect(localeFallbackChain('fr', 'de-formal')).toEqual(['fr', 'de-formal', 'de']);
  });
});

describe('resolveLocale', () => {
  const map: LocaleMap<string> = { en: 'hello', de: 'hallo' };

  it('returns exact locale match', () => {
    expect(resolveLocale(map, 'de', 'en')).toBe('hallo');
  });

  it('falls back to defaultLocale when locale missing', () => {
    expect(resolveLocale(map, 'fr', 'en')).toBe('hello');
  });

  it('falls back from a register variant to its base language before default', () => {
    // The core de-formal contract: only `de` is filled, request `de-formal`,
    // default `en` → resolves to the `de` value (NOT `en`).
    expect(resolveLocale({ en: 'hello', de: 'hallo' }, 'de-formal', 'en')).toBe('hallo');
  });

  it('prefers an explicit register-variant value over its base', () => {
    expect(
      resolveLocale({ de: 'hallo', 'de-formal': 'guten Tag' }, 'de-formal', 'en'),
    ).toBe('guten Tag');
  });

  it('returns undefined when no chain entry has a value', () => {
    expect(resolveLocale({ fr: 'bonjour' }, 'de', 'en')).toBeUndefined();
  });

  it('returns undefined for null map', () => {
    expect(resolveLocale(null, 'en', 'en')).toBeUndefined();
  });

  it('returns undefined for undefined map', () => {
    expect(resolveLocale(undefined, 'en', 'en')).toBeUndefined();
  });

  it('works with non-string value types', () => {
    const numbers: LocaleMap<number> = { en: 1, de: 2 };
    expect(resolveLocale(numbers, 'de', 'en')).toBe(2);
    expect(resolveLocale(numbers, 'fr', 'en')).toBe(1);
  });

  it('falls back to a case-insensitive key match when the exact key misses', () => {
    // Map keyed `de-at` (lowercase), negotiated tag `de-AT`: exact lookup
    // misses, case-insensitive fallback finds it before dropping to the base.
    expect(
      resolveLocale({ 'de-at': 'Servus', de: 'Hallo' }, 'de-AT', 'en'),
    ).toBe('Servus');
  });

  it('prefers an exact-case key over a case-insensitive one', () => {
    expect(
      resolveLocale({ 'de-AT': 'exact', 'de-at': 'lower' }, 'de-AT', 'en'),
    ).toBe('exact');
  });

  it('matches the default locale case-insensitively too', () => {
    expect(resolveLocale({ EN: 'hi' }, 'fr', 'en')).toBe('hi');
  });
});

describe('resolveLocaleStrict', () => {
  it('returns the value when present', () => {
    expect(resolveLocaleStrict({ en: 'x', de: 'y' }, 'de', 'en')).toBe('y');
  });

  it('falls back to defaultLocale', () => {
    expect(resolveLocaleStrict({ en: 'x' }, 'de', 'en')).toBe('x');
  });

  it('throws when both missing with descriptive message', () => {
    expect(() => resolveLocaleStrict({ fr: 'z' }, 'de', 'en')).toThrow(
      /missing both 'de' and default 'en'/,
    );
  });
});

describe('isLocaleMapComplete', () => {
  it('returns true when all locales have non-empty values', () => {
    expect(isLocaleMapComplete({ en: 'a', de: 'b' }, ['en', 'de'])).toBe(true);
  });

  it('returns false when a locale is missing', () => {
    expect(isLocaleMapComplete({ en: 'a' }, ['en', 'de'])).toBe(false);
  });

  it('returns false when a locale has empty string', () => {
    expect(isLocaleMapComplete({ en: 'a', de: '' }, ['en', 'de'])).toBe(false);
  });

  it('treats a whitespace-only value as missing', () => {
    expect(isLocaleMapComplete({ en: 'a', de: '   ' }, ['en', 'de'])).toBe(false);
  });

  it('returns true for empty supportedLocales (vacuous)', () => {
    expect(isLocaleMapComplete({}, [])).toBe(true);
  });
});

describe('missingLocales', () => {
  it('returns empty array when complete', () => {
    expect(missingLocales({ en: 'a', de: 'b' }, ['en', 'de'])).toEqual([]);
  });

  it('returns missing locales', () => {
    expect(missingLocales({ en: 'a' }, ['en', 'de', 'fr'])).toEqual([
      'de',
      'fr',
    ]);
  });

  it('treats empty strings as missing', () => {
    expect(missingLocales({ en: 'a', de: '' }, ['en', 'de'])).toEqual(['de']);
  });

  it('treats whitespace-only strings as missing', () => {
    expect(missingLocales({ en: 'a', de: '  \t ' }, ['en', 'de'])).toEqual([
      'de',
    ]);
  });

  it('returns all when map is empty', () => {
    expect(missingLocales({}, ['en', 'de'])).toEqual(['en', 'de']);
  });
});

describe('isLocaleMap', () => {
  it('returns true for valid string LocaleMap', () => {
    expect(isLocaleMap({ en: 'hello', de: 'hallo' })).toBe(true);
  });

  it('returns true for number LocaleMap (homogeneous primitives)', () => {
    expect(isLocaleMap({ en: 1, de: 2 })).toBe(true);
  });

  it('returns false when a key is not BCP-47', () => {
    expect(isLocaleMap({ title: 'hello', de: 'hallo' })).toBe(false);
  });

  it('returns false for mixed value types', () => {
    expect(isLocaleMap({ en: 'hello', de: 42 })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isLocaleMap({})).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isLocaleMap(['en', 'de'])).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLocaleMap(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isLocaleMap('en')).toBe(false);
    expect(isLocaleMap(42)).toBe(false);
    expect(isLocaleMap(true)).toBe(false);
  });

  it('returns false when any value is an object', () => {
    expect(isLocaleMap({ en: { nested: 'x' } })).toBe(false);
  });
});

describe('resolveLocaleDeep', () => {
  it('passes primitives through', () => {
    expect(resolveLocaleDeep('hello', 'de', 'en')).toBe('hello');
    expect(resolveLocaleDeep(42, 'de', 'en')).toBe(42);
    expect(resolveLocaleDeep(null, 'de', 'en')).toBe(null);
    expect(resolveLocaleDeep(true, 'de', 'en')).toBe(true);
  });

  it('resolves a top-level LocaleMap', () => {
    expect(resolveLocaleDeep({ en: 'hi', de: 'hallo' }, 'de', 'en')).toBe(
      'hallo',
    );
  });

  it('resolves nested LocaleMap leaves inside an object', () => {
    const input = {
      variant: 'hero',
      title: { en: 'Welcome', de: 'Willkommen' },
      body: { en: 'Hello', de: 'Hallo' },
    };
    expect(resolveLocaleDeep(input, 'de', 'en')).toEqual({
      variant: 'hero',
      title: 'Willkommen',
      body: 'Hallo',
    });
  });

  it('recurses through arrays', () => {
    const input = [
      { title: { en: 'A', de: 'A-de' } },
      { title: { en: 'B', de: 'B-de' } },
    ];
    expect(resolveLocaleDeep(input, 'de', 'en')).toEqual([
      { title: 'A-de' },
      { title: 'B-de' },
    ]);
  });

  it('falls back to defaultLocale for missing locale', () => {
    const input = { title: { en: 'Welcome', de: 'Willkommen' } };
    expect(resolveLocaleDeep(input, 'fr', 'en')).toEqual({ title: 'Welcome' });
  });

  it('does not touch non-LocaleMap structural keys', () => {
    const input = { count: 5, variant: 'hero', layout: 'wide' };
    expect(resolveLocaleDeep(input, 'de', 'en')).toEqual(input);
  });
});

describe('anyLocaleValue', () => {
  it('prefers the preferred locale when present', () => {
    expect(anyLocaleValue({ de: 'Hallo', en: 'Hello' }, 'de')).toBe('Hallo');
  });

  it('falls back to en when preferred is absent', () => {
    expect(anyLocaleValue({ de: 'Hallo', en: 'Hello' }, 'fr')).toBe('Hello');
  });

  it('prefers en over other locales when no preferred is given', () => {
    expect(anyLocaleValue({ de: 'Hallo', en: 'Hello' })).toBe('Hello');
  });

  it('is independent of key insertion order', () => {
    expect(anyLocaleValue({ nl: 'Hoi', de: 'Hallo' })).toBe('de' < 'nl' ? 'Hallo' : 'Hoi');
    expect(anyLocaleValue({ de: 'Hallo', nl: 'Hoi' })).toBe('Hallo');
    expect(anyLocaleValue({ nl: 'Hoi', de: 'Hallo' })).toBe('Hallo');
  });

  it('uses sorted key order for the non-en tail', () => {
    expect(anyLocaleValue({ it: 'Ciao', fr: 'Salut', de: 'Hallo' })).toBe('Hallo');
  });

  it('skips null/undefined entries', () => {
    const map: LocaleMap<string> = { en: undefined, de: 'Hallo' };
    expect(anyLocaleValue(map)).toBe('Hallo');
  });

  it('returns undefined for null, undefined, and empty maps', () => {
    expect(anyLocaleValue(null)).toBeUndefined();
    expect(anyLocaleValue(undefined)).toBeUndefined();
    expect(anyLocaleValue({})).toBeUndefined();
  });
});

describe('resolveLocaleOrAny', () => {
  it('resolves via the fallback chain first', () => {
    expect(resolveLocaleOrAny({ de: 'Hallo', en: 'Hello' }, 'de', 'en')).toBe('Hallo');
    expect(resolveLocaleOrAny({ en: 'Hello' }, 'de', 'en')).toBe('Hello');
  });

  it('falls back to any translation when the chain is empty', () => {
    expect(resolveLocaleOrAny({ fr: 'Salut' }, 'de', 'en')).toBe('Salut');
  });

  it('defaults defaultLocale to locale (two-arg form)', () => {
    const map: LocaleMap<string> = { de: 'Hallo', fr: 'Salut' };
    expect(resolveLocaleOrAny(map, 'de')).toBe(resolveLocaleOrAny(map, 'de', 'de'));
    expect(resolveLocaleOrAny(map, 'de')).toBe('Hallo');
  });

  it('resolves a register variant through its base before any-fallback', () => {
    expect(resolveLocaleOrAny({ de: 'Hallo', fr: 'Salut' }, 'de-formal')).toBe('Hallo');
  });

  it('returns undefined for null and empty maps', () => {
    expect(resolveLocaleOrAny(null, 'de')).toBeUndefined();
    expect(resolveLocaleOrAny({}, 'de')).toBeUndefined();
  });
});
