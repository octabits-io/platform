import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { z } from 'zod'
import { useWizardStepValidation } from './index.ts'

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().min(0),
})

function setup(state: { name: string; email: string; age: number }, activeStepValue = 0) {
  const form = ref<{ validate: (opts?: { name?: string[] }) => Promise<unknown> } | null>(null)
  const stepper = ref<{ next: () => void, prev: () => void, hasNext: boolean, hasPrev: boolean } | null>(null)
  const activeStep = ref(activeStepValue)

  const api = useWizardStepValidation({
    form,
    stepper,
    activeStep,
    state,
    schema,
    stepFields: {
      0: ['name'] as const,
      1: ['email', 'age'] as const,
    },
  })

  return { ...api, form, stepper, activeStep }
}

describe('useWizardStepValidation', () => {
  describe('currentStepValid', () => {
    it('is true for a step with no configured fields', () => {
      const { currentStepValid, activeStep } = setup({ name: '', email: '', age: 0 })
      activeStep.value = 2 // not in stepFields
      expect(currentStepValid.value).toBe(true)
    })

    it('is false when the current step field fails schema validation', () => {
      const { currentStepValid } = setup({ name: '', email: '', age: 0 })
      expect(currentStepValid.value).toBe(false)
    })

    it('is true when the current step field passes schema validation', () => {
      const { currentStepValid } = setup({ name: 'Villa', email: '', age: 0 })
      expect(currentStepValid.value).toBe(true)
    })

    it('only validates fields belonging to the current step (partial pick)', () => {
      // age is invalid in the schema's terms if negative, but step 0 only
      // cares about `name` — an invalid `age` must not fail step 0.
      const { currentStepValid } = setup({ name: 'Villa', email: 'not-an-email', age: -5 })
      expect(currentStepValid.value).toBe(true)
    })

    it('validates multiple fields together for a multi-field step', () => {
      const { currentStepValid, activeStep } = setup({ name: 'Villa', email: 'not-an-email', age: 5 })
      activeStep.value = 1
      expect(currentStepValid.value).toBe(false)
    })

    it('re-derives when a schema Ref changes', () => {
      // Real callers pass a `computed(() => schema)` (see
      // ListingManualCreateFlow.vue), not `ref(schema)` — computed() doesn't
      // deep-wrap its return value, so the zod schema instance stays
      // untouched. `ref()` would deep-reactive-wrap it and break zod's
      // internal non-configurable properties; this test mirrors real usage.
      const strict = ref(true)
      const looseSchema = computed(() =>
        strict.value
          ? z.object({ name: z.string().min(1), email: z.string().email(), age: z.number() })
          : z.object({ name: z.string(), email: z.string().email(), age: z.number() }),
      )
      const form = ref(null)
      const stepper = ref(null)
      const activeStep = ref(0)
      const state = { name: '', email: '', age: 0 }

      const { currentStepValid } = useWizardStepValidation({
        form,
        stepper,
        activeStep,
        state,
        schema: looseSchema,
        stepFields: { 0: ['name'] as const },
      })

      expect(currentStepValid.value).toBe(false)

      strict.value = false
      expect(currentStepValid.value).toBe(true)
    })
  })

  describe('goNext', () => {
    it('calls stepper.next() when the step has no fields to validate', async () => {
      const { goNext, stepper, activeStep } = setup({ name: '', email: '', age: 0 })
      activeStep.value = 2
      const next = vi.fn()
      stepper.value = { next, prev: vi.fn(), hasNext: true, hasPrev: true }

      await goNext()

      expect(next).toHaveBeenCalledOnce()
    })

    it('calls form.validate() with the step fields, then advances on success', async () => {
      const { goNext, form, stepper } = setup({ name: 'Villa', email: '', age: 0 })
      const validate = vi.fn().mockResolvedValue(undefined)
      const next = vi.fn()
      form.value = { validate }
      stepper.value = { next, prev: vi.fn(), hasNext: true, hasPrev: true }

      await goNext()

      expect(validate).toHaveBeenCalledWith({ name: ['name'] })
      expect(next).toHaveBeenCalledOnce()
    })

    it('does not advance when form.validate() rejects', async () => {
      const { goNext, form, stepper } = setup({ name: '', email: '', age: 0 })
      const validate = vi.fn().mockRejectedValue(new Error('invalid'))
      const next = vi.fn()
      form.value = { validate }
      stepper.value = { next, prev: vi.fn(), hasNext: true, hasPrev: true }

      await goNext()

      expect(next).not.toHaveBeenCalled()
    })

    it('is a no-op when form/stepper refs are unset', async () => {
      const { goNext } = setup({ name: '', email: '', age: 0 })
      await expect(goNext()).resolves.toBeUndefined()
    })
  })

  describe('goPrev', () => {
    it('calls stepper.prev()', () => {
      const { goPrev, stepper } = setup({ name: '', email: '', age: 0 })
      const prev = vi.fn()
      stepper.value = { next: vi.fn(), prev, hasNext: true, hasPrev: true }

      goPrev()

      expect(prev).toHaveBeenCalledOnce()
    })

    it('is a no-op when stepper ref is unset', () => {
      const { goPrev } = setup({ name: '', email: '', age: 0 })
      expect(() => goPrev()).not.toThrow()
    })
  })
})
