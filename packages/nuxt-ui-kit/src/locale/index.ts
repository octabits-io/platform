import {
  computed,
  inject,
  provide,
  ref,
  toValue,
  watchEffect,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type ModelRef,
  type Ref,
} from 'vue';
import { baseLocaleOf, resolveLocale, type LocaleMap } from '@octabits-io/framework/utils';

export { pruneLocaleMap } from './pruneLocaleMap.ts';

/** Reactive source of the content-locale set a locale field edits against. */
export interface LocaleFieldSource {
  /** Supported content locales (BCP-47 tags). */
  locales: MaybeRefOrGetter<string[]>;
  /** The locale whose value is required (completeness "error" dot). */
  defaultLocale: MaybeRefOrGetter<string>;
}

export type LocaleTabIndicator =
  | { kind: 'error' } // default locale empty — must be filled
  | { kind: 'warning' } // a normal locale is empty
  | { kind: 'inherits' } // a register-variant override is empty → inherits its base
  | null;

/**
 * Scope the locale field editors expose through their `#ai` slot, so a page
 * can replace the default translate button with a combined AI menu without
 * re-implementing the translate machinery.
 */
export interface LocaleFieldTranslateScope {
  /** Translate exists for this field at all (multiple locales, not `no-translate`). */
  available: boolean;
  /** Translate is currently actionable (some tab has text, empty targets exist). */
  canTranslate: boolean;
  translating: boolean;
  translate: () => void;
}

/** What a quick-translate provider returns — drives the sparkle button. */
export interface LocaleFieldTranslator {
  translating: Ref<boolean>;
  canTranslate: Ref<boolean> | ComputedRef<boolean>;
  translate: () => void;
}

export interface UseTranslateOptions {
  model: ModelRef<LocaleMap<string> | undefined>;
  /** What the field is about (e.g. "Listing title") — passed as AI context. */
  context: MaybeRefOrGetter<string | undefined>;
  /** Source locale (from `useLocaleField().translateSource`). */
  source: ComputedRef<string | null>;
  /** Empty visible locales to fill (from `useLocaleField().translateTargets`). */
  targetLocales: ComputedRef<string[]>;
}

/**
 * App context the locale field components resolve at setup time. Both members
 * are *factories invoked during the component's own setup*, so they may call
 * composables (state, route, API clients) without executing at provide time.
 */
export interface LocaleFieldContext {
  /** Resolve the app's content-locale source. */
  useSource: () => LocaleFieldSource;
  /**
   * Optional quick-translate provider; the AI-translate button renders only
   * when this is present.
   */
  useTranslate?: (options: UseTranslateOptions) => LocaleFieldTranslator;
}

export const LOCALE_FIELD_CONTEXT: InjectionKey<LocaleFieldContext> = Symbol(
  'nuxt-ui-kit:locale-field-context',
);

/** Provide the locale-field context (call once, near the app root). */
export function provideLocaleFieldContext(context: LocaleFieldContext): void {
  provide(LOCALE_FIELD_CONTEXT, context);
}

/** Resolve the locale-field context inside a component (throws when absent). */
export function useLocaleFieldContext(): LocaleFieldContext {
  const context = inject(LOCALE_FIELD_CONTEXT, null);
  if (!context) {
    throw new Error(
      '[nuxt-ui-kit] LocaleInput/LocaleTextarea need provideLocaleFieldContext() near the app root.',
    );
  }
  return context;
}

/**
 * Tab plumbing shared by every per-locale field editor: one tab per content
 * locale, an active-tab ref, and the completeness indicator. Value access
 * stays with the caller — pass `hasValue` so the indicator works for any
 * value type (strings, rich-text documents, …).
 *
 * **Register variants** (e.g. `de-formal`, whose base `de` is also supported)
 * are a tone/overlay axis, not a real language: a label like "Hotel" is
 * identical in both. So variant tabs are **hidden by default** and only shown
 * when `registerOverride` is true (reader-addressing prose — descriptions,
 * body copy). When shown, a blank variant value *inherits* its base locale
 * (neutral hint, not a "missing" warning), and clearing the field should
 * **delete the key** so the resolver falls through to the base
 * (`de-formal → de`).
 */
export function useLocaleTabs(
  hasValue: (locale: string) => boolean,
  source: LocaleFieldSource,
  registerOverride: MaybeRefOrGetter<boolean> = false,
) {
  const supportedLocales = computed(() => toValue(source.locales));
  const defaultLocale = computed(() => toValue(source.defaultLocale));

  /** A locale whose base language is itself also supported (e.g. `de-formal` ⊂ `de`). */
  const isVariant = (loc: string) =>
    baseLocaleOf(loc) !== loc && supportedLocales.value.includes(baseLocaleOf(loc));

  const visibleLocales = computed(() => {
    const filtered = toValue(registerOverride)
      ? supportedLocales.value
      : supportedLocales.value.filter((loc) => !isVariant(loc));
    // `requireDefaultLocale` checks the literal default-locale key, even when
    // it's a register variant (e.g. `de-formal`) that register-invariant
    // fields would otherwise hide — always surface a tab for it (tabLabel
    // still renders its base form) so the operator can fill the required value.
    return filtered.includes(defaultLocale.value)
      ? filtered
      : [...filtered, defaultLocale.value];
  });

  const active = ref('');
  watchEffect(() => {
    if (!visibleLocales.value.includes(active.value)) {
      active.value = visibleLocales.value.includes(defaultLocale.value)
        ? defaultLocale.value
        : (visibleLocales.value[0] ?? '');
    }
  });

  /**
   * A register variant carries a lowercase BCP-47 *variant* subtag (e.g.
   * `de-formal`) — as opposed to a region (`de-AT`) or script (`zh-Hans`).
   * Formality is a tenant-wide choice, so the tab reads as the plain language
   * ("DE"), not the internal `DE-FORMAL` token.
   */
  const REGISTER_VARIANT = /-[a-z]{4,8}$/;
  const tabLabel = (loc: string) =>
    (REGISTER_VARIANT.test(loc) ? baseLocaleOf(loc) : loc).toUpperCase();

  const items = computed(() =>
    visibleLocales.value.map((loc) => ({ label: tabLabel(loc), value: loc })),
  );

  const indicatorOf = (loc: string): LocaleTabIndicator => {
    if (hasValue(loc)) return null;
    if (isVariant(loc)) return { kind: 'inherits' };
    return loc === defaultLocale.value ? { kind: 'error' } : { kind: 'warning' };
  };

  /**
   * Source locale for quick translate: the active tab when it has a value, so
   * freshly edited text wins; otherwise the default locale, otherwise the
   * first filled visible locale. `null` when every tab is empty. The fallback
   * matters because the operator typically sits on the tab they want FILLED —
   * translate must not go dead just because the active tab is the empty one.
   */
  const translateSource = computed<string | null>(() => {
    if (hasValue(active.value)) return active.value;
    if (hasValue(defaultLocale.value)) return defaultLocale.value;
    return visibleLocales.value.find(hasValue) ?? null;
  });

  /**
   * Locales quick-translate would fill from {@link translateSource}: visible,
   * empty, and not the source itself. Blank register variants are excluded —
   * a blank variant deliberately inherits its base, and writing a translation
   * would shadow that fallthrough — except when the variant IS the default
   * locale (a required value, so it is a legitimate target).
   */
  const translateTargets = computed(() =>
    visibleLocales.value.filter(
      (loc) =>
        loc !== translateSource.value &&
        !hasValue(loc) &&
        (!isVariant(loc) || loc === defaultLocale.value),
    ),
  );

  return {
    items,
    active,
    indicatorOf,
    isVariant,
    defaultLocale,
    visibleLocales,
    translateSource,
    translateTargets,
  };
}

/**
 * String-valued locale field over a single `LocaleMap<string>` model — the
 * composable behind `LocaleInput` / `LocaleTextarea`. See
 * {@link useLocaleTabs} for the tab/indicator semantics.
 */
export function useLocaleField(
  model: ModelRef<LocaleMap<string> | undefined>,
  source: LocaleFieldSource,
  registerOverride: MaybeRefOrGetter<boolean> = false,
) {
  const hasValue = (loc: string) => {
    const v = model.value?.[loc];
    return typeof v === 'string' && v.length > 0;
  };

  const {
    items,
    active,
    indicatorOf,
    isVariant,
    defaultLocale,
    translateSource,
    translateTargets,
  } = useLocaleTabs(hasValue, source, registerOverride);

  const activeValue = computed<string>({
    get: () => model.value?.[active.value] ?? '',
    set: (val) => {
      const next = { ...(model.value ?? {}) };
      // A cleared register-variant override drops the key so the resolver falls
      // through to the base locale, rather than shadowing it with an empty string.
      if (val === '' && isVariant(active.value)) {
        delete next[active.value];
      } else {
        next[active.value] = val;
      }
      model.value = next;
    },
  });

  return {
    items,
    active,
    activeValue,
    indicatorOf,
    defaultLocale,
    translateSource,
    translateTargets,
  };
}

/**
 * Resolve a `LocaleMap<string>` to a single display string for list / detail
 * surfaces, using the **default content locale** — deliberately decoupled
 * from the app's own UI language, which is unrelated chrome and would
 * otherwise select content arbitrarily. Lists therefore always show the
 * canonical value, consistently for every user; the per-locale values stay
 * fully editable via `LocaleInput` / `LocaleTextarea`.
 */
export function createLocaleDisplay(source: Pick<LocaleFieldSource, 'defaultLocale'>) {
  /** Resolve a LocaleMap to its default-locale string, falling back when empty. */
  function display(map: LocaleMap<string> | null | undefined, fallback = ''): string {
    const defaultLocale = toValue(source.defaultLocale);
    return resolveLocale(map, defaultLocale, defaultLocale) ?? fallback;
  }

  return { display };
}

/**
 * Translation-completeness summary rendered by `TranslationBadge`:
 * `complete` when every in-use translatable leaf covers all supported
 * locales; `missing` counts absent leaves per locale otherwise.
 */
export interface TranslationStatus {
  complete: boolean;
  missing: Record<string, number>;
}
