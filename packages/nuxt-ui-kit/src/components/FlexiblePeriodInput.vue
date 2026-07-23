<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
//
// Flexible travel-period wish: a date *window* (earliest arrival → latest
// departure) plus a desired stay length in nights — "between Jun 1 and
// Jun 21 for 7 nights". Composes DateRangeInput (kind="travel") for the
// window and adds a nights input, cross-field validation, and a metadata
// line (window span, flexibility, example stay).
//
// i18n key contract: flexPeriod.* (earliestStart/latestEnd/nightsLabel/
// clear/windowSpan/flexibility/example/errors.*) and period.travel.nights,
// plus the composed DateRangeInput's dateRange.* keys.
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import DateRangeInput from './DateRangeInput.vue'
import {
  calculateNights,
  createDateFormatter,
  shiftIso,
  type Period,
} from '@octabits-io/nuxt-ui-kit/dates'

type InputSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const props = withDefaults(defineProps<{
  /**
   * The wish window in travel semantics: `start` = earliest possible
   * arrival, `end` = latest possible departure (ISO YYYY-MM-DD, `''` =
   * unset). Unlike DateRangeInput's booking-space model, both bounds are
   * literal calendar dates — conversion happens at the inner boundary.
   */
  modelValue: Period
  /** Desired stay length in nights; `null` = unset. */
  nights: number | null
  minNights?: number
  maxNights?: number
  disabled?: boolean
  size?: InputSize
  /** Calendar trigger icon, passed through to the window inputs. */
  icon?: string
  startLabel?: string
  endLabel?: string
  /** Show the built-in clear (X) button when anything is set. */
  clearable?: boolean
}>(), {
  minNights: 1,
  maxNights: 365,
  disabled: false,
  size: 'md',
  icon: undefined,
  startLabel: undefined,
  endLabel: undefined,
  clearable: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: Period]
  'update:nights': [value: number | null]
  'change': [payload: { window: Period, nights: number | null, isValid: boolean }]
}>()

const { t, locale } = useI18n()
const { formatDateMedium } = createDateFormatter({ getLocale: () => locale.value })

const startAriaLabel = computed(() => props.startLabel || t('flexPeriod.earliestStart'))
const endAriaLabel = computed(() => props.endLabel || t('flexPeriod.latestEnd'))

// The inner DateRangeInput binds in booking semantics (end = last booked
// day) and displays departure via kind="travel". Our model's end IS the
// departure date, so convert ±1 day at this boundary only. shiftIso('')
// stays '' — half-filled pairs pass through literally (never auto-fixed).
const innerPeriod = computed<Period>({
  get: () => ({
    start: props.modelValue.start,
    end: shiftIso(props.modelValue.end, -1),
  }),
  set: (v) => {
    emit('update:modelValue', {
      start: v.start,
      end: shiftIso(v.end, 1),
    })
  },
})

const nightsValue = computed<number | null>({
  get: () => props.nights,
  set: v => emit('update:nights', v ?? null),
})

const hasAnyValue = computed(() =>
  !!props.modelValue.start || !!props.modelValue.end || props.nights != null,
)

function clearAll() {
  emit('update:modelValue', { start: '', end: '' })
  emit('update:nights', null)
}

// --- Derived metadata ---

const windowComplete = computed(() =>
  !!props.modelValue.start
  && !!props.modelValue.end
  && props.modelValue.end > props.modelValue.start,
)

/** Nights the full window spans (arrival → departure, exclusive end). */
const windowNights = computed<number | null>(() =>
  windowComplete.value ? calculateNights(props.modelValue) : null,
)

/** Scheduling slack: how many nights the stay can shift inside the window. */
const flexNights = computed<number | null>(() => {
  if (windowNights.value === null || props.nights == null) return null
  const flex = windowNights.value - props.nights
  return flex > 0 ? flex : null
})

/** Example stay anchored at the earliest arrival, when start + nights known. */
const exampleStay = computed(() => {
  if (!props.modelValue.start || props.nights == null || props.nights < 1) return ''
  // A stay that doesn't fit the window has no truthful example — the
  // exceed-window error below explains the situation instead.
  if (windowNights.value !== null && props.nights > windowNights.value) return ''
  return t('flexPeriod.example', {
    start: formatDateMedium(props.modelValue.start),
    end: formatDateMedium(shiftIso(props.modelValue.start, props.nights)),
  })
})

const metadataParts = computed<string[]>(() => {
  const parts: string[] = []
  if (windowNights.value !== null && windowNights.value > 0) {
    parts.push(t('flexPeriod.windowSpan', { nights: t('period.travel.nights', windowNights.value) }))
  }
  if (flexNights.value !== null) {
    parts.push(t('flexPeriod.flexibility', { nights: t('period.travel.nights', flexNights.value) }))
  }
  if (exampleStay.value) {
    parts.push(exampleStay.value)
  }
  return parts
})

// --- Validation (nights axis only; window errors are the inner input's job) ---

const nightsError = computed<string | null>(() => {
  if (props.nights == null) return null
  if (props.nights < props.minNights) {
    return t('flexPeriod.errors.minNights', { n: props.minNights })
  }
  if (props.nights > props.maxNights) {
    return t('flexPeriod.errors.maxNights', { n: props.maxNights })
  }
  if (windowNights.value !== null && props.nights > windowNights.value) {
    return t('flexPeriod.errors.nightsExceedWindow', {
      nights: t('period.travel.nights', props.nights),
      window: t('period.travel.nights', windowNights.value),
    })
  }
  return null
})

const nightsInputColor = computed<'error' | undefined>(() =>
  nightsError.value !== null ? 'error' : undefined,
)

// A wish is progressive capture: fully empty is valid; a window, once
// started, must be complete and ordered (in travel space, departure strictly
// after arrival = at least one night).
const windowValid = computed(() => {
  const { start, end } = props.modelValue
  if (!start && !end) return true
  return windowComplete.value
})

const isValid = computed(() => windowValid.value && nightsError.value === null)

watch(
  () => [props.modelValue.start, props.modelValue.end, props.nights] as const,
  ([start, end, nights]) => {
    emit('change', { window: { start, end }, nights, isValid: isValid.value })
  },
)
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-start gap-2">
      <DateRangeInput
        v-model="innerPeriod"
        kind="travel"
        :disabled="disabled"
        :size="size"
        :icon="icon"
        :start-label="startAriaLabel"
        :end-label="endAriaLabel"
        class="flex-1"
      />
      <UInputNumber
        v-model="nightsValue"
        :min="minNights"
        :max="maxNights"
        :size="size"
        :disabled="disabled"
        :color="nightsInputColor"
        :aria-label="t('flexPeriod.nightsLabel')"
        :placeholder="t('flexPeriod.nightsLabel')"
        class="w-28 shrink-0"
      />
      <UButton
        v-if="clearable && hasAnyValue"
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        :size="size"
        :disabled="disabled"
        :aria-label="t('flexPeriod.clear')"
        @click="clearAll"
      />
    </div>

    <!-- Slot for a derived summary shown between the inputs and the hints,
         matching DateRangeInput's slot for layout parity. -->
    <slot name="summary" />

    <p v-if="metadataParts.length" class="text-xs text-muted">
      {{ metadataParts.join(' · ') }}
    </p>

    <p v-if="nightsError" class="text-sm text-error">
      {{ nightsError }}
    </p>
  </div>
</template>
