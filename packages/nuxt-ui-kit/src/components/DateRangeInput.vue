<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: dateRange.* (checkIn/checkOut/errors.*/availability*/
// atTime/nextDay/checking) and period.travel.nights / period.booking.days.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarDate } from '@internationalized/date'
import type { DateValue } from '@internationalized/date'
import { addDays, differenceInDays, eachDayOfInterval, format, parseISO } from 'date-fns'
import UInputDate from '@nuxt/ui/components/InputDate.vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCalendar from '@nuxt/ui/components/Calendar.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import {
  calculateDays,
  createDateFormatter,
  shiftIso,
  type Period,
} from '@octabits-io/nuxt-ui-kit/dates'

type AvailabilityStatus = {
  status: 'available' | 'unavailable' | 'partial'
  conflictDates?: string[]
  message?: string
}

type InputSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const props = withDefaults(defineProps<{
  modelValue: Period
  minDays?: number
  maxDays?: number
  disabled?: boolean
  size?: InputSize
  /** Calendar trigger icon. Defaults to a plain calendar; pass e.g. `i-lucide-calendar-check` for booking/occupancy ranges. */
  icon?: string
  startLabel?: string
  endLabel?: string
  availabilityCheck?: (period: Period) => Promise<AvailabilityStatus>
  blockedDates?: string[]
  softBlockedDates?: string[]
  checkInTime?: string
  checkOutTime?: string
  /**
   * Date semantics of the *end* input, matching `PeriodDisplay`.
   *
   * `booking` (default) → the end input shows the bound period's `end`
   * directly (inclusive last booked day); span counted in days.
   *
   * `travel` → the end input and its calendar show the **departure date**
   * (`end` + 1 day); span counted in nights. The bound `modelValue` stays in
   * booking semantics — conversion happens only at the input boundary.
   */
  kind?: 'travel' | 'booking'
}>(), {
  minDays: 1,
  maxDays: undefined,
  disabled: false,
  size: 'md',
  icon: 'i-lucide-calendar',
  startLabel: undefined,
  endLabel: undefined,
  availabilityCheck: undefined,
  blockedDates: () => [],
  softBlockedDates: () => [],
  checkInTime: undefined,
  checkOutTime: undefined,
  kind: 'booking',
})

const emit = defineEmits<{
  'update:modelValue': [value: Period]
  'change': [payload: { period: Period; isValid: boolean }]
  'availability': [status: AvailabilityStatus]
}>()

const { t, locale } = useI18n()
const { formatDate, formatDateMedium } = createDateFormatter({ getLocale: () => locale.value })

const touched = ref(false)
const startPopoverOpen = ref(false)
const endPopoverOpen = ref(false)

// ISO (YYYY-MM-DD) of the day under the cursor in whichever calendar is open.
// Only one popover is open at a time, so a single shared ref suffices. Drives
// the live span preview/count; cleared when both popovers close.
const hoveredDay = ref<string | null>(null)
watch([startPopoverOpen, endPopoverOpen], ([s, e]) => {
  if (!s && !e) hoveredDay.value = null
})

const startPopoverTitle = computed(() => props.startLabel || t('dateRange.checkIn'))
const endPopoverTitle = computed(() => props.endLabel || t('dateRange.checkOut'))

// In travel mode the end input/calendar shows the departure date = booking
// end + 1 day. The bound modelValue always stays in booking semantics.
const travelOffset = computed(() => (props.kind === 'travel' ? 1 : 0))

/** The end date as displayed in the end input/calendar (departure in travel mode). */
const displayEnd = computed(() => shiftIso(props.modelValue.end, travelOffset.value))

// reka-ui's UCalendar emits a wider union (DateValue | DateRange | DateValue[]
// | null | undefined) than what we use. Accept it and narrow to CalendarDate.
type CalendarEmitValue = DateValue | DateValue[] | { start?: DateValue, end?: DateValue } | null | undefined

// UPSTREAM BUG (nuxt/ui ≥ 4.9.0): UCalendar accepts `default-placeholder` but
// never reads it — the month/year view-switching feature (nuxt/ui#6582) moved
// placeholder state into a local ref initialized from `placeholder` →
// `modelValue` → `defaultValue` → today, so an empty calendar always opens on
// the current month. Both popover calendars below therefore bind `:placeholder`
// (initial value only; internal month navigation still works) so the empty end
// calendar opens on the start date's month and vice versa. Revert to
// `:default-placeholder` once fixed upstream.

function commitPeriod(start: string, end: string) {
  touched.value = true
  emit('update:modelValue', { start, end })
}

function onStartCalendarSelect(v: CalendarEmitValue) {
  const date = v instanceof CalendarDate ? v : undefined
  startPopoverOpen.value = false
  if (!date) {
    startDate.value = undefined
    return
  }
  const iso = date.toString()
  const end = props.modelValue.end
  // Ordering checks run in display (travel) space so a departure date never
  // ends up before the arrival date.
  if (end && iso >= shiftIso(end, travelOffset.value) && travelOffset.value > 0) {
    // Picking a "start" on/after the existing departure: re-anchor the range
    // to start on the picked date, clearing the end for re-selection.
    commitPeriod(iso, '')
    return
  }
  if (end && iso > end && travelOffset.value === 0) {
    // Picking a "start" later than the existing end: order the two instead of
    // leaving an invalid range — the picked date becomes the end, the old end
    // becomes the start.
    commitPeriod(end, iso)
    return
  }
  startDate.value = date
  if (!end) {
    // Defer past the current event loop tick: the click that selected the
    // start date is still bubbling, and reka-ui's outside-click detector
    // would otherwise immediately dismiss the freshly-opened end popover.
    // We need a delay long enough for both the start popover's exit transition
    // and reka-ui's DismissableLayer teardown to finish.
    setTimeout(() => {
      endPopoverOpen.value = true
    }, 150)
  }
}

function onEndCalendarSelect(v: CalendarEmitValue) {
  const date = v instanceof CalendarDate ? v : undefined
  endPopoverOpen.value = false
  if (!date) {
    endDate.value = undefined
    return
  }
  // In travel mode the picked day is the departure date; the bound end is the
  // last booked day (departure − 1).
  const iso = date.toString()
  const start = props.modelValue.start
  if (start && iso === start && travelOffset.value > 0) {
    // Departure on the arrival day is a zero-night stay — ignore.
    return
  }
  if (start && iso < start) {
    // Picking an "end" earlier than the existing start: order the two instead
    // of leaving an invalid range — the picked date becomes the start, the old
    // start becomes the end (converted back to booking semantics).
    commitPeriod(iso, shiftIso(start, -travelOffset.value))
    return
  }
  endDate.value = date
}

// --- ISO ↔ CalendarDate bridge ---

function isoToCalendar(iso: string): CalendarDate | undefined {
  if (!iso) return undefined
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new CalendarDate(y, m, d)
}
function dateValueToIso(v: DateValue | undefined | null): string {
  return v ? v.toString() : ''
}

const startDate = computed<CalendarDate | undefined>({
  get: () => isoToCalendar(props.modelValue.start),
  set: (v) => {
    touched.value = true
    emit('update:modelValue', { start: dateValueToIso(v), end: props.modelValue.end })
  },
})
const endDate = computed<CalendarDate | undefined>({
  get: () => isoToCalendar(displayEnd.value),
  set: (v) => {
    touched.value = true
    emit('update:modelValue', {
      start: props.modelValue.start,
      end: shiftIso(dateValueToIso(v), -travelOffset.value),
    })
  },
})

// --- Blocked-date predicate (used by both inputs & their popover calendars) ---

const blockedSet = computed(() => new Set(props.blockedDates))
const softBlockedSet = computed(() => new Set(props.softBlockedDates))
function isDateDisabled(date: DateValue): boolean {
  return blockedSet.value.has(date.toString())
}
function isDateSoftBlocked(date: DateValue): boolean {
  const iso = date.toString()
  return softBlockedSet.value.has(iso) && !blockedSet.value.has(iso)
}
// End-side predicates run in display space: in travel mode a departure day D
// only occupies the night up to D − 1, so D is selectable iff D − 1 is free.
// This keeps "checkout-only" days (the start day of the next booking) pickable
// as departure dates for back-to-back stays.
function isEndDateDisabled(date: DateValue): boolean {
  return blockedSet.value.has(shiftIso(date.toString(), -travelOffset.value))
}
function isEndDateSoftBlocked(date: DateValue): boolean {
  const iso = shiftIso(date.toString(), -travelOffset.value)
  return softBlockedSet.value.has(iso) && !blockedSet.value.has(iso)
}

// --- Range preview (anchor + live span) shown inside the calendar popovers ---
//
// Each single-date calendar only knows its own date, so the *other* endpoint
// was previously invisible. We mark it (the "anchor") and shade the span from
// it to the day being chosen (the selected opposite date, or — while picking —
// the hovered day). ISO YYYY-MM-DD strings sort chronologically, so plain
// string comparison gives the ordering without CalendarDate.compare.

type CalendarSide = 'start' | 'end'
type DayRole = 'anchor' | 'target' | 'inRange' | null

// For the end calendar the anchor is the start date (and vice versa); the
// target is the hovered day, falling back to this calendar's own date. All
// dates here are in display space — the end side shows the departure date in
// travel mode.
function anchorFor(side: CalendarSide): string | undefined {
  return (side === 'end' ? props.modelValue.start : displayEnd.value) || undefined
}
function targetFor(side: CalendarSide): string | undefined {
  // Hover wins so re-editing an already-set endpoint previews the new candidate
  // span live; falls back to this calendar's own committed date at rest.
  const own = side === 'end' ? displayEnd.value : props.modelValue.start
  return hoveredDay.value || own || undefined
}

function dayRole(dayIso: string, anchor?: string, target?: string): DayRole {
  if (!anchor) return null
  if (dayIso === anchor) return 'anchor'
  if (!target || target === anchor) return null
  const [lo, hi] = anchor <= target ? [anchor, target] : [target, anchor]
  if (dayIso === target) return 'target'
  if (dayIso > lo && dayIso < hi) return 'inRange'
  return null
}

const dayRoleClasses: Record<Exclude<DayRole, null>, string> = {
  anchor: 'bg-primary text-inverted font-medium',
  target: 'bg-primary/30 text-primary font-medium',
  inRange: 'bg-primary/15 text-primary',
}
const PILL_BASE = 'inline-flex items-center justify-center rounded px-1.5'

// Full pill classes for a day cell. Soft-block (amber) wins over range styling;
// '' leaves the plain number (no padding, unchanged from before).
function dayPillClass(date: DateValue, side: CalendarSide): string {
  const softBlocked = side === 'end' ? isEndDateSoftBlocked(date) : isDateSoftBlocked(date)
  if (softBlocked) return `${PILL_BASE} bg-warning/20 text-warning line-through`
  const iso = date.toString()
  // This calendar's own selected date is rendered natively by UCalendar (solid
  // primary circle with contrast text). Don't override its colour, or the
  // number disappears (text-primary on a primary background).
  const own = side === 'end' ? displayEnd.value : props.modelValue.start
  if (iso === own) return ''
  const role = dayRole(iso, anchorFor(side), targetFor(side))
  return role ? `${PILL_BASE} ${dayRoleClasses[role]}` : ''
}

// Live "N nights/days" label for the popover header — only while both the
// anchor and a target (selected or hovered) exist. Count + wording mirror
// PeriodDisplay so the header matches the period shown alongside the input.
function spanLabel(side: CalendarSide): string {
  const anchor = anchorFor(side)
  const target = targetFor(side)
  if (!anchor || !target || anchor === target) return ''
  const [start, end] = anchor <= target ? [anchor, target] : [target, anchor]
  if (props.kind === 'travel') {
    // Display space: `end` is already the departure date.
    const nights = differenceInDays(new Date(end), new Date(start))
    if (nights <= 0) return ''
    return t('period.travel.nights', nights)
  }
  const days = calculateDays({ start, end }) // inclusive booked days
  if (days <= 0) return ''
  return t('period.booking.days', days)
}

// Compute blocked dates that fall inside the selected range (excluding the
// endpoints themselves — those are reported as a more specific error).
const blockedInsideRange = computed<string[]>(() => {
  const { start, end } = props.modelValue
  if (!start || !end || end < start) return []
  if (props.blockedDates.length === 0) return []
  try {
    return eachDayOfInterval({ start: parseISO(start), end: parseISO(end) })
      .map(d => format(d, 'yyyy-MM-dd'))
      .filter(iso => blockedSet.value.has(iso) && iso !== start && iso !== end)
  } catch {
    return []
  }
})

const startIsBlocked = computed(() =>
  !!props.modelValue.start && blockedSet.value.has(props.modelValue.start),
)
const endIsBlocked = computed(() =>
  !!props.modelValue.end && blockedSet.value.has(props.modelValue.end),
)

const errorMessage = computed<string | null>(() => {
  const { start, end } = props.modelValue
  if (!touched.value && !start && !end) return null
  if (!start || !end) return t('dateRange.errors.bothRequired')
  if (end < start) return t('dateRange.errors.endAfterStart')

  const days = calculateDays({ start, end })
  if (props.minDays > 1 && days < props.minDays) {
    return t('dateRange.errors.minDays', { n: props.minDays })
  }
  if (props.maxDays !== undefined && days > props.maxDays) {
    return t('dateRange.errors.maxDays', { n: props.maxDays })
  }

  if (startIsBlocked.value) {
    return t('dateRange.errors.blockedDate', { date: formatDate(start) })
  }
  if (endIsBlocked.value) {
    return t('dateRange.errors.blockedDate', { date: formatDate(end) })
  }
  if (blockedInsideRange.value.length > 0) {
    return t('dateRange.errors.blockedRange', {
      dates: blockedInsideRange.value.map(formatDate).join(', '),
    })
  }

  return null
})

const isValid = computed(() => errorMessage.value === null
  && !!props.modelValue.start
  && !!props.modelValue.end)

const inputColor = computed<'error' | undefined>(() =>
  errorMessage.value !== null && touched.value ? 'error' : undefined,
)

// Mark hard-blocked cells in the calendar popover. reka-ui sets data-disabled
// when is-date-disabled returns true (hard block, unselectable). Soft-blocked
// dates are painted via the #day slot below so the cell stays clickable —
// passing them to is-date-unavailable would prevent selection.
const calendarUi = {
  cellTrigger:
    'data-[disabled]:!bg-error/15 data-[disabled]:!text-error data-[disabled]:line-through data-[disabled]:!opacity-100',
}

// --- Availability check ---

const availabilityStatus = ref<AvailabilityStatus | null>(null)
const availabilityLoading = ref(false)

// Minimal trailing-edge debounce — avoids a @vueuse/core peer for one helper.
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const runAvailabilityCheck = debounce(async (period: Period) => {
  if (!props.availabilityCheck) return
  availabilityLoading.value = true
  try {
    const result = await props.availabilityCheck(period)
    availabilityStatus.value = result
    emit('availability', result)
  } catch (err) {
    availabilityStatus.value = null
    console.warn('[DateRangeInput] availabilityCheck failed', err)
  } finally {
    availabilityLoading.value = false
  }
}, 300)

watch(
  () => [props.modelValue.start, props.modelValue.end, props.availabilityCheck] as const,
  ([start, end, check]) => {
    if (!check) {
      availabilityStatus.value = null
      return
    }
    if (!isValid.value) {
      availabilityStatus.value = null
      availabilityLoading.value = false
      return
    }
    runAvailabilityCheck({ start, end })
  },
  { immediate: true },
)

watch(
  () => ({ ...props.modelValue }),
  (period) => {
    emit('change', { period, isValid: isValid.value })
  },
)

const availabilityIcon = computed(() => {
  switch (availabilityStatus.value?.status) {
    case 'available': return 'i-lucide-check-circle-2'
    case 'unavailable': return 'i-lucide-alert-circle'
    case 'partial': return 'i-lucide-alert-triangle'
    default: return ''
  }
})

const availabilityColor = computed(() => {
  switch (availabilityStatus.value?.status) {
    case 'available': return 'text-success'
    case 'unavailable': return 'text-error'
    case 'partial': return 'text-warning'
    default: return ''
  }
})

const availabilityMessage = computed(() => {
  const s = availabilityStatus.value
  if (!s) return ''
  if (s.message) return s.message
  switch (s.status) {
    case 'available': return t('dateRange.availabilityOk')
    case 'unavailable': return t('dateRange.availabilityConflict')
    case 'partial': return t('dateRange.availabilityPartial')
  }
})

// --- Check-in / check-out time hint ---

const showTimeHint = computed(() =>
  props.checkInTime !== undefined || props.checkOutTime !== undefined,
)

/** Customer-facing checkout date: the day after the (inclusive) last booked day. */
function checkoutDateIso(end: string): string {
  if (!end) return ''
  try {
    return format(addDays(parseISO(end), 1), 'yyyy-MM-dd')
  } catch {
    return ''
  }
}

const checkInHint = computed(() => {
  if (!props.checkInTime) return ''
  const start = props.modelValue.start
  if (start) {
    return `${t('dateRange.checkIn')}: ${t('dateRange.atTime', {
      date: formatDateMedium(start),
      time: props.checkInTime,
    })}`
  }
  return `${t('dateRange.checkIn')} ${props.checkInTime}`
})

const checkOutHint = computed(() => {
  if (!props.checkOutTime) return ''
  const end = props.modelValue.end
  // In travel mode the end input already shows the departure date, so the
  // "(next day)" clarifier is only useful for booking-semantics inputs.
  const suffix = props.kind === 'booking' ? ` ${t('dateRange.nextDay')}` : ''
  if (end) {
    const iso = checkoutDateIso(end)
    return `${t('dateRange.checkOut')}: ${t('dateRange.atTime', {
      date: iso ? formatDateMedium(iso) : '',
      time: props.checkOutTime,
    })}${suffix}`
  }
  return `${t('dateRange.checkOut')} ${props.checkOutTime}${suffix}`
})

const timeHintParts = computed(() =>
  [checkInHint.value, checkOutHint.value].filter(Boolean),
)
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <UInputDate
        v-model="startDate"
        :is-date-disabled="isDateDisabled"
        :size="size"
        :disabled="disabled"
        :color="inputColor"
        :aria-label="startLabel"
        class="flex-1"
      >
        <template #trailing>
          <UPopover v-model:open="startPopoverOpen">
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              :icon="icon"
              :aria-label="startLabel"
              :disabled="disabled"
              class="px-0"
            />
            <template #content>
              <div class="flex flex-col" @pointerleave="hoveredDay = null">
                <p class="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
                  <span class="text-xs font-medium text-muted uppercase tracking-wide">
                    {{ startPopoverTitle }}
                  </span>
                  <span v-if="spanLabel('start')" class="text-xs font-medium text-primary">
                    {{ spanLabel('start') }}
                  </span>
                </p>
                <UCalendar
                  :model-value="startDate"
                  :placeholder="startDate ?? endDate"
                  :is-date-disabled="isDateDisabled"
                  :ui="calendarUi"
                  class="p-2"
                  @update:model-value="onStartCalendarSelect"
                >
                  <template #day="{ day }">
                    <span :class="dayPillClass(day, 'start')" @pointerenter="hoveredDay = day.toString()">
                      {{ day.day }}
                    </span>
                  </template>
                </UCalendar>
              </div>
            </template>
          </UPopover>
        </template>
      </UInputDate>

      <span class="text-muted shrink-0" aria-hidden="true">→</span>

      <UInputDate
        v-model="endDate"
        :is-date-disabled="isEndDateDisabled"
        :size="size"
        :disabled="disabled"
        :color="inputColor"
        :aria-label="endLabel"
        class="flex-1"
      >
        <template #trailing>
          <UPopover v-model:open="endPopoverOpen">
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              :icon="icon"
              :aria-label="endLabel"
              :disabled="disabled"
              class="px-0"
            />
            <template #content>
              <div class="flex flex-col" @pointerleave="hoveredDay = null">
                <p class="flex items-baseline justify-between gap-2 px-3 pt-2 pb-1">
                  <span class="text-xs font-medium text-muted uppercase tracking-wide">
                    {{ endPopoverTitle }}
                  </span>
                  <span v-if="spanLabel('end')" class="text-xs font-medium text-primary">
                    {{ spanLabel('end') }}
                  </span>
                </p>
                <UCalendar
                  :model-value="endDate"
                  :placeholder="endDate ?? startDate"
                  :is-date-disabled="isEndDateDisabled"
                  :ui="calendarUi"
                  class="p-2"
                  @update:model-value="onEndCalendarSelect"
                >
                  <template #day="{ day }">
                    <span :class="dayPillClass(day, 'end')" @pointerenter="hoveredDay = day.toString()">
                      {{ day.day }}
                    </span>
                  </template>
                </UCalendar>
              </div>
            </template>
          </UPopover>
        </template>
      </UInputDate>
    </div>

    <!-- Slot for a derived summary (e.g. the resulting travel period) shown
         between the inputs and the time/availability hints. -->
    <slot name="summary" />

    <p v-if="showTimeHint && timeHintParts.length" class="text-xs text-muted">
      {{ timeHintParts.join(' • ') }}
    </p>

    <p v-if="errorMessage" class="text-sm text-error">
      {{ errorMessage }}
    </p>

    <div
      v-else-if="availabilityCheck && (availabilityLoading || availabilityStatus)"
      class="flex items-center gap-1.5 text-sm"
      :class="availabilityLoading ? 'text-muted' : availabilityColor"
    >
      <template v-if="availabilityLoading">
        <UIcon name="i-lucide-loader-2" class="animate-spin" />
        <span>{{ t('dateRange.checking') }}</span>
      </template>
      <template v-else-if="availabilityStatus">
        <UIcon :name="availabilityIcon" />
        <span>{{ availabilityMessage }}</span>
        <span
          v-if="availabilityStatus.status === 'partial' && availabilityStatus.conflictDates?.length"
          class="text-muted"
        >
          ({{ availabilityStatus.conflictDates.map(formatDate).join(', ') }})
        </span>
      </template>
    </div>
  </div>
</template>
