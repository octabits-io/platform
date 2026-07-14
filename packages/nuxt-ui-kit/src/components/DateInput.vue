<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
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
 */
const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  disabled?: boolean
}>(), { placeholder: undefined, disabled: false })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { locale } = useI18n()
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
</script>

<template>
  <UPopover v-model:open="open">
    <UButton
      variant="outline"
      color="neutral"
      icon="i-lucide-calendar"
      class="w-full justify-start font-normal"
      :class="{ 'text-dimmed': !calendarValue }"
      :disabled="disabled"
    >
      {{ label || placeholder }}
    </UButton>
    <template #content>
      <UCalendar v-model="calendarValue" class="p-2" />
    </template>
  </UPopover>
</template>
