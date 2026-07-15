<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: localeField.inheritsBaseLocale.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LocaleTabIndicator } from '@octabits-io/nuxt-ui-kit/locale'

/**
 * Renders a locale tab label with its completeness indicator:
 * red dot = default locale empty, orange = a normal locale empty,
 * neutral dot = a register-variant override empty (inherits its base locale).
 */
const props = defineProps<{
  label: string
  indicator: LocaleTabIndicator
}>()

const { t } = useI18n()

const dotClass = computed(() => {
  switch (props.indicator?.kind) {
    case 'error':
      return 'bg-error'
    case 'warning':
      return 'bg-warning'
    case 'inherits':
      return 'bg-muted'
    default:
      return null
  }
})

const title = computed(() =>
  props.indicator?.kind === 'inherits' ? t('localeField.inheritsBaseLocale') : undefined,
)
</script>

<template>
  <span class="flex items-center gap-1.5" :title="title">
    {{ label }}
    <span v-if="dotClass" class="size-1.5 shrink-0 rounded-full" :class="dotClass" />
  </span>
</template>
