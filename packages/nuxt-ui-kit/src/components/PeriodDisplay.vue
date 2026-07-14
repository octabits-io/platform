<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: period.travel.tooltip / period.travel.nights (plural) /
// period.booking.tooltip / period.booking.days (plural).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { addDays, differenceInDays } from 'date-fns'
import UTooltip from '@nuxt/ui/components/Tooltip.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import { calculateDays, createDateFormatter, type Period } from '@octabits-io/nuxt-ui-kit/dates'

const props = withDefaults(
  defineProps<{
    /** ISO date range. `end` is the last booked day (not the checkout date). */
    period: Period
    /**
     * `travel`  → check-in → check-out, counted in nights (guest stay).
     * `booking` → check-in → last booked day, counted in days (occupancy).
     */
    kind: 'travel' | 'booking'
    /** Render the `· N nights/days` suffix. */
    showCount?: boolean
    size?: 'xs' | 'sm' | 'md'
  }>(),
  { showCount: true, size: 'sm' },
)

const { t, locale } = useI18n()
const { formatDate, formatCheckoutDate } = createDateFormatter({ getLocale: () => locale.value })

const isTravel = computed(() => props.kind === 'travel')

const icon = computed(() => (isTravel.value ? 'i-lucide-luggage' : 'i-lucide-calendar-check'))
const tooltip = computed(() => t(isTravel.value ? 'period.travel.tooltip' : 'period.booking.tooltip'))

const startText = computed(() => formatDate(props.period.start))
const endText = computed(() =>
  isTravel.value
    ? formatCheckoutDate(props.period.end)
    : formatDate(props.period.end),
)

const count = computed(() =>
  isTravel.value
    ? differenceInDays(
        addDays(new Date(props.period.end), 1),
        new Date(props.period.start),
      )
    : calculateDays(props.period),
)
const countText = computed(() =>
  isTravel.value
    ? t('period.travel.nights', count.value)
    : t('period.booking.days', count.value),
)

const iconSize = computed(() =>
  props.size === 'xs' ? 'size-3.5' : props.size === 'md' ? 'size-5' : 'size-4',
)
const textSize = computed(() =>
  props.size === 'xs' ? 'text-xs' : props.size === 'md' ? 'text-base' : 'text-sm',
)
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5" :class="textSize">
    <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
      <UTooltip :text="tooltip">
        <UIcon :name="icon" class="shrink-0 text-muted" :class="iconSize" :aria-label="tooltip" />
      </UTooltip>
      {{ startText }} – {{ endText }}
    </span>
    <span v-if="showCount" class="whitespace-nowrap text-muted">· {{ countText }}</span>
  </div>
</template>
