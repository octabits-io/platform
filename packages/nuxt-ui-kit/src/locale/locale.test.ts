import { describe, expect, it } from 'vitest';
import { nextTick, ref, type ModelRef } from 'vue';
import {
  createLocaleDisplay,
  pruneLocaleMap,
  useLocaleField,
  useLocaleTabs,
  type LocaleFieldSource,
} from './index.ts';

const source = (locales: string[], defaultLocale = locales[0]!): LocaleFieldSource => ({
  locales,
  defaultLocale,
});

describe('pruneLocaleMap', () => {
  it('drops empty-string leaves so they stop shadowing the fallback locale', () => {
    // The historical bug class this guards: an operator clears the German
    // tab, the form sends { en: 'Hello', de: '' }, and downstream reads
    // treat the '' as "German has content" instead of falling back to en.
    expect(pruneLocaleMap({ en: 'Hello', de: '' })).toEqual({ en: 'Hello' });
  });

  it('keeps non-empty leaves for every locale', () => {
    expect(pruneLocaleMap({ en: 'Hello', de: 'Hallo' })).toEqual({ en: 'Hello', de: 'Hallo' });
  });

  it('drops every locale when all leaves are empty strings', () => {
    expect(pruneLocaleMap({ en: '', de: '' })).toEqual({});
  });

  it('returns {} for null, undefined, and empty input', () => {
    expect(pruneLocaleMap(null)).toEqual({});
    expect(pruneLocaleMap(undefined)).toEqual({});
    expect(pruneLocaleMap({})).toEqual({});
  });

  it('drops undefined leaves the same as empty-string leaves', () => {
    expect(pruneLocaleMap({ en: 'Hello', de: undefined as unknown as string })).toEqual({
      en: 'Hello',
    });
  });

  it('treats whitespace-only strings as present (does not trim)', () => {
    // pruneLocaleMap only filters falsy values — a leaf of ' ' is truthy and
    // deliberately passes through untouched; trimming is a different concern.
    expect(pruneLocaleMap({ en: 'Hello', de: ' ' })).toEqual({ en: 'Hello', de: ' ' });
  });

  it('does not mutate the input map', () => {
    const input = { en: 'Hello', de: '' };
    pruneLocaleMap(input);
    expect(input).toEqual({ en: 'Hello', de: '' });
  });
});

describe('useLocaleTabs', () => {
  it('renders one tab per locale with uppercase labels', () => {
    const { items } = useLocaleTabs(() => true, source(['en', 'de']));
    expect(items.value).toEqual([
      { label: 'EN', value: 'en' },
      { label: 'DE', value: 'de' },
    ]);
  });

  it('hides register variants by default and shows them with registerOverride', () => {
    const tabs = useLocaleTabs(() => true, source(['en', 'de', 'de-formal']));
    expect(tabs.items.value.map((i) => i.value)).toEqual(['en', 'de']);

    const overridden = useLocaleTabs(() => true, source(['en', 'de', 'de-formal']), true);
    expect(overridden.items.value.map((i) => i.value)).toEqual(['en', 'de', 'de-formal']);
    // The variant tab reads as its base language, not the internal token.
    expect(overridden.items.value.at(-1)!.label).toBe('DE');
  });

  it('always surfaces the default locale even when it is a hidden variant', () => {
    const tabs = useLocaleTabs(() => true, source(['de', 'de-formal'], 'de-formal'));
    expect(tabs.visibleLocales.value).toContain('de-formal');
  });

  it('activates the default locale initially', async () => {
    const tabs = useLocaleTabs(() => true, source(['en', 'de'], 'de'));
    await nextTick();
    expect(tabs.active.value).toBe('de');
  });

  it('grades indicators: error for default, warning for normal, inherits for variants', () => {
    const tabs = useLocaleTabs(() => false, source(['en', 'de', 'de-formal'], 'en'), true);
    expect(tabs.indicatorOf('en')).toEqual({ kind: 'error' });
    expect(tabs.indicatorOf('de')).toEqual({ kind: 'warning' });
    expect(tabs.indicatorOf('de-formal')).toEqual({ kind: 'inherits' });
  });

  it('picks the translate source: active tab when filled, else default, else first filled', async () => {
    const values: Record<string, string> = { de: 'Hallo' };
    const tabs = useLocaleTabs((loc) => !!values[loc], source(['en', 'de', 'fr'], 'en'));
    await nextTick();
    // active = en (default) but empty → falls to first filled visible locale
    expect(tabs.translateSource.value).toBe('de');
  });

  it('targets only empty non-variant locales, excluding the source', async () => {
    const values: Record<string, string> = { en: 'Hello' };
    const tabs = useLocaleTabs(
      (loc) => !!values[loc],
      source(['en', 'de', 'de-formal', 'fr'], 'en'),
      true,
    );
    await nextTick();
    // de-formal is a blank variant → inherits its base, never a target
    expect(tabs.translateTargets.value).toEqual(['de', 'fr']);
  });

  it('reports null translate source when every tab is empty', async () => {
    const tabs = useLocaleTabs(() => false, source(['en', 'de']));
    await nextTick();
    // Targets still enumerate the empty locales — the translate action is
    // gated on having a source (canTranslate), not on the target list.
    expect(tabs.translateSource.value).toBeNull();
  });
});

describe('useLocaleField', () => {
  const modelRef = (initial: Record<string, string>) =>
    ref(initial) as unknown as ModelRef<Record<string, string | undefined> | undefined>;

  it('reads and writes the active locale value on the map', async () => {
    const model = modelRef({ en: 'Hello' });
    const field = useLocaleField(model, source(['en', 'de'], 'en'));
    await nextTick();
    expect(field.activeValue.value).toBe('Hello');

    field.activeValue.value = 'Hi';
    expect(model.value).toEqual({ en: 'Hi' });

    field.active.value = 'de';
    field.activeValue.value = 'Hallo';
    expect(model.value).toEqual({ en: 'Hi', de: 'Hallo' });
  });

  it('keeps an empty string for cleared normal locales', async () => {
    const model = modelRef({ en: 'Hello' });
    const field = useLocaleField(model, source(['en', 'de'], 'en'));
    await nextTick();
    field.activeValue.value = '';
    expect(model.value).toEqual({ en: '' });
  });

  it('deletes the key for cleared register-variant overrides so the base shows through', async () => {
    const model = modelRef({ de: 'Hallo', 'de-formal': 'Guten Tag' });
    const field = useLocaleField(model, source(['de', 'de-formal'], 'de'), true);
    await nextTick();
    field.active.value = 'de-formal';
    await nextTick();
    field.activeValue.value = '';
    expect(model.value).toEqual({ de: 'Hallo' });
  });
});

describe('createLocaleDisplay', () => {
  it('collapses a map to the default content locale', () => {
    const { display } = createLocaleDisplay({ defaultLocale: 'de' });
    expect(display({ en: 'Hello', de: 'Hallo' })).toBe('Hallo');
  });

  it('uses the fallback when the default-locale chain has no value', () => {
    const { display } = createLocaleDisplay({ defaultLocale: 'de' });
    // The chain is requested → base → default → default's base; it never
    // falls through to arbitrary other locales.
    expect(display({ en: 'Hello' }, '—')).toBe('—');
    expect(display(null, '—')).toBe('—');
    expect(display({}, '—')).toBe('—');
  });

  it('tracks a reactive default locale', () => {
    const defaultLocale = ref('en');
    const { display } = createLocaleDisplay({ defaultLocale });
    expect(display({ en: 'Hello', de: 'Hallo' })).toBe('Hello');
    defaultLocale.value = 'de';
    expect(display({ en: 'Hello', de: 'Hallo' })).toBe('Hallo');
  });
});
