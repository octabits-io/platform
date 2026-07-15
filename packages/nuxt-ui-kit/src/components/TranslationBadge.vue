<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: localeField.translationStatus.complete / .missing.
// Requires provideLocaleFieldContext() near the app root.
import { computed, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import UTooltip from '@nuxt/ui/components/Tooltip.vue'
import UBadge from '@nuxt/ui/components/Badge.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import {
  useLocaleFieldContext,
  type TranslationStatus,
} from '@octabits-io/nuxt-ui-kit/locale'

/**
 * Translation-completeness badge for list rows and detail headers.
 *
 * - Hidden for single-locale content (nothing to translate into).
 * - Green check when every in-use translatable leaf covers all supported
 *   locales (register variants inherit their base).
 * - Orange with the total missing-leaf count otherwise; the tooltip breaks
 *   the count down per locale.
 */
const props = defineProps<{
  status: TranslationStatus | undefined
}>()

const { t } = useI18n()
const { locales } = useLocaleFieldContext().useSource()

const visible = computed(() => !!props.status && toValue(locales).length > 1)

const totalMissing = computed(() =>
  Object.values(props.status?.missing ?? {}).reduce((sum, n) => sum + n, 0),
)

const tooltip = computed(() => {
  if (!props.status) return ''
  if (props.status.complete) return t('localeField.translationStatus.complete')
  const perLocale = Object.entries(props.status.missing)
    .map(([locale, n]) => `${locale.toUpperCase()}: ${n}`)
    .join(', ')
  return t('localeField.translationStatus.missing', { details: perLocale })
})
</script>

<template>
  <UTooltip v-if="visible" :text="tooltip">
    <UBadge
      v-if="!status!.complete"
      color="warning"
      variant="subtle"
      size="xs"
      icon="i-lucide-languages"
      :label="String(totalMissing)"
    />
    <UIcon
      v-else
      name="i-lucide-check-circle-2"
      class="size-4 text-success"
      :aria-label="t('localeField.translationStatus.complete')"
    />
  </UTooltip>
</template>
