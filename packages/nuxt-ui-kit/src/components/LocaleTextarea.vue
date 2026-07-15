<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: localeField.translate (+ LocaleTab's key).
// Requires provideLocaleFieldContext() near the app root.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LocaleMap } from '@octabits-io/framework/utils'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import UTextarea from '@nuxt/ui/components/Textarea.vue'
import UTooltip from '@nuxt/ui/components/Tooltip.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import {
  useLocaleField,
  useLocaleFieldContext,
  type LocaleFieldTranslateScope,
} from '@octabits-io/nuxt-ui-kit/locale'
import LocaleTab from './LocaleTab.vue'

/**
 * Multi-line variant of `LocaleInput` — edits a `LocaleMap<string>` field
 * (descriptions, body copy, …) with a per-locale tab bar. See `LocaleInput`
 * for the completeness-dot semantics.
 *
 * Reader-addressing prose is where formal/informal registers actually differ, so
 * set `register-override` here to expose e.g. `de-formal` as an optional override
 * tab (blank = inherits `de`). Leave it off for register-invariant copy.
 */
const model = defineModel<LocaleMap<string>>({ default: () => ({}) })

const props = defineProps<{
  label?: string
  description?: string
  help?: string
  placeholder?: string
  /** Form field path — wires validation errors to this field. */
  name?: string
  required?: boolean
  maxlength?: number
  rows?: number
  /** Surface register-variant locales (e.g. `de-formal`) as optional override tabs. */
  registerOverride?: boolean
  /** AI-translate context describing what the field holds. Defaults to `label`. */
  translateContext?: string
  /** Hide the AI-translate button (slugs, codes — values that must not be translated). */
  noTranslate?: boolean
}>()

defineSlots<{
  /**
   * Replaces the default AI-translate button with custom field-level AI
   * actions (e.g. a menu merging generate + translate). The scope carries the
   * field's translate machinery so the override can still offer it.
   */
  ai?: (scope: LocaleFieldTranslateScope) => unknown
}>()

const { t } = useI18n()
const { useSource, useTranslate } = useLocaleFieldContext()

const { items, active, activeValue, indicatorOf, translateSource, translateTargets } = useLocaleField(
  model,
  useSource(),
  () => props.registerOverride ?? false,
)

// The translate provider is optional app wiring — without it the sparkle
// button never renders and the #ai slot scope reports unavailable.
const translator = useTranslate?.({
  model,
  context: () => props.translateContext ?? props.label,
  source: translateSource,
  targetLocales: translateTargets,
})

const aiScope = computed<LocaleFieldTranslateScope>(() => ({
  available: !!translator && items.value.length > 1 && !props.noTranslate,
  canTranslate: translator?.canTranslate.value ?? false,
  translating: translator?.translating.value ?? false,
  translate: () => translator?.translate(),
}))
</script>

<template>
  <UFormField :label="label" :description="description" :help="help" :name="name" :required="required">
    <div class="flex flex-col gap-2">
      <!-- A single effective locale needs no tab chrome — degrade to a plain textarea
           (the row still renders when a page slots in field-level AI actions). -->
      <div v-if="items.length > 1 || !!$slots.ai" class="flex items-center justify-between gap-2">
        <UTabs
          v-if="items.length > 1"
          v-model="active"
          :items="items"
          :content="false"
          size="sm"
          color="neutral"
          variant="link"
          :ui="{ list: 'gap-2' }"
        >
          <template #default="{ item }">
            <LocaleTab :label="item.label as string" :indicator="indicatorOf(item.value as string)" />
          </template>
        </UTabs>
        <span v-else />
        <slot name="ai" v-bind="aiScope">
          <UTooltip v-if="aiScope.available" :text="t('localeField.translate')">
            <UButton
              icon="i-lucide-languages"
              size="xs"
              variant="ghost"
              color="primary"
              :loading="aiScope.translating"
              :disabled="!aiScope.canTranslate"
              :aria-label="t('localeField.translate')"
              @click.prevent="aiScope.translate()"
            />
          </UTooltip>
        </slot>
      </div>
      <UTextarea
        v-model="activeValue"
        :placeholder="placeholder"
        :maxlength="maxlength"
        :rows="rows ?? 4"
        autoresize
        class="w-full"
      />
    </div>
  </UFormField>
</template>
