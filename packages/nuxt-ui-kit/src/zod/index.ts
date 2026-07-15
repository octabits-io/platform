import { computed, isRef, type Ref } from 'vue';
import * as z from 'zod';

type ZodLocaleFactory = () => Parameters<typeof z.config>[0];

export interface ZodLocaleSyncOptions {
  /** Locale code → zod locale factory (from `zod/locales`), e.g. `{ de, en }`. */
  locales: Record<string, ZodLocaleFactory>;
  /** Applied when the active locale has no entry in `locales`. */
  defaultLocale: string;
  /** Read the active UI locale code. */
  getLocale: () => string;
  /**
   * Wire locale-change reactivity — call `apply` with the new code whenever
   * the UI locale changes (e.g. `apply => watch(() => i18n.locale.value, apply)`).
   */
  onLocaleChange: (apply: (code: string) => void) => void;
}

/**
 * Keep Zod's built-in error messages in the user's language: applies the
 * matching `zod/locales` config immediately and re-applies on every locale
 * change. Call once from an app plugin.
 */
export function setupZodLocaleSync(options: ZodLocaleSyncOptions): void {
  const apply = (code: string) => {
    const factory = options.locales[code] ?? options.locales[options.defaultLocale];
    if (factory) z.config(factory());
  };
  apply(options.getLocale());
  options.onLocaleChange(apply);
}

interface FormLike {
  validate: (opts?: { name?: string[] }) => Promise<unknown>;
}

interface StepperLike {
  next: () => void;
  prev: () => void;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface UseWizardStepValidationOptions<TState> {
  // `any` ref typing avoids circular Vue template-ref inference (the `form`
  // ref's type is resolved from the template, which references state).
  form: Ref<any>;
  stepper: Ref<any>;
  activeStep: Ref<number>;
  state: TState;
  schema: z.ZodObject<z.ZodRawShape> | Ref<z.ZodObject<z.ZodRawShape>>;
  stepFields: Partial<Record<number, readonly (keyof TState)[]>>;
}

/**
 * Gates a stepper + form multi-step wizard by validating only the current
 * step's fields via `schema.pick(...)`: `currentStepValid` drives the Next
 * button's enabled state reactively, `goNext` runs the form-level validation
 * for the step's fields (surfacing messages) before advancing, `goPrev` just
 * steps back. Works with any form/stepper exposing the structural `validate`
 * / `next` / `prev` surface (e.g. Nuxt UI's UForm + UStepper).
 */
export function useWizardStepValidation<TState extends object>(
  options: UseWizardStepValidationOptions<TState>,
) {
  const { form, stepper, activeStep, state, schema, stepFields } = options;

  function getSchema(): z.ZodObject<z.ZodRawShape> {
    return isRef(schema) ? schema.value : schema;
  }

  const currentStepValid = computed<boolean>(() => {
    const fields = stepFields[activeStep.value];
    if (!fields || fields.length === 0) return true;

    const partial: Record<string, unknown> = {};
    const pickShape: Record<string, true> = {};
    for (const f of fields) {
      partial[f as string] = (state as Record<string, unknown>)[f as string];
      pickShape[f as string] = true;
    }

    return getSchema().pick(pickShape as never).safeParse(partial).success;
  });

  async function goNext(): Promise<void> {
    const fields = stepFields[activeStep.value];
    if (fields && fields.length > 0) {
      try {
        const f = form.value as FormLike | null | undefined;
        await f?.validate({ name: fields.map(String) });
      } catch {
        return;
      }
    }
    const s = stepper.value as StepperLike | null | undefined;
    s?.next();
  }

  function goPrev(): void {
    const s = stepper.value as StepperLike | null | undefined;
    s?.prev();
  }

  return { currentStepValid, goNext, goPrev };
}
