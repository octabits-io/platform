<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: dateInput.clear (falls back to "Clear" when absent).
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CalendarDate, parseDate } from '@internationalized/date'
import UPopover from '@nuxt/ui/components/Popover.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCalendar from '@nuxt/ui/components/Calendar.vue'

/**
 * Single-date input built on the Nuxt UI 4 date primitives (`UPopover` +
 * `UCalendar`). The model is an ISO `YYYY-MM-DD` string so it drops into Zod
 * schemas and API payloads without conversion. Use this instead of a raw
 * `<UInput type="date">`.
 *
 * **Two of these are how you build an OPEN-ENDED range** — "since March", "up
 * to last New Year". `DateRangeInput` is the other shape: it models a stay, so
 * it wants both bounds and at least one day between them. A filter usually
 * does not.
 */
const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
  /**
   * Trigger size. The calendar itself never shrinks — it is a popover with its
   * own room wherever it opens, and a hard-to-hit day cell is a worse trade
   * than a tall button.
   */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  /**
   * Show an × on the trigger once a date is set, emitting `''`.
   *
   * A calendar can only ever PICK: clicking the selected day again re-selects
   * it, so without this there is no way back to "no date" — which is fine for
   * a required field and wrong for anything optional, a filter bound above
   * all. Off by default so existing required fields are unchanged.
   */
  clearable?: boolean
}>(), {
  placeholder: undefined,
  disabled: false,
  size: 'md',
  clearable: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t, te, locale } = useI18n()
const open = ref(false)

const calendarValue = computed<CalendarDate | undefined>({
  get() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(props.modelValue)) return undefined
    try {
      return parseDate(props.modelValue)
    } catch {
      return undefined
    }
  },
  set(val) {
    emit('update:modelValue', val ? val.toString() : '')
    open.value = false
  },
})

const label = computed(() => {
  const v = calendarValue.value
  if (!v) return ''
  return new Date(v.year, v.month - 1, v.day).toLocaleDateString(locale.value)
})

/** Consumers that have not added the key still get a usable label. */
const clearLabel = computed(() => (te('dateInput.clear') ? t('dateInput.clear') : 'Clear'))

function clear(event: Event) {
  // The × sits inside the popover's trigger, so without this the click opens
  // the calendar it just finished clearing.
  event.stopPropagation()
  emit('update:modelValue', '')
  open.value = false
}
</script>

<template>
  <div class="flex min-w-0 items-center gap-1">
    <UPopover v-model:open="open" class="min-w-0 flex-1">
      <UButton
        variant="outline"
        color="neutral"
        icon="i-lucide-calendar"
        :size="size"
        class="w-full justify-start font-normal"
        :class="{ 'text-dimmed': !calendarValue }"
        :disabled="disabled"
      >
        <span class="truncate">{{ label || placeholder }}</span>
      </UButton>
      <template #content>
        <UCalendar v-model="calendarValue" class="p-2" />
      </template>
    </UPopover>
    <UButton
      v-if="clearable && calendarValue"
      icon="i-lucide-x"
      variant="ghost"
      color="neutral"
      :size="size"
      :disabled="disabled"
      :aria-label="clearLabel"
      @click="clear"
    />
  </div>
</template>
