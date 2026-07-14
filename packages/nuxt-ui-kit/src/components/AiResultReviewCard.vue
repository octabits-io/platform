<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: ai.review.title / description / currentValue / apply / dismiss.
import { useI18n } from 'vue-i18n'
import UCard from '@nuxt/ui/components/Card.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UButton from '@nuxt/ui/components/Button.vue'

const { t } = useI18n()

export interface AiResultField {
  label: string
  value: string
  currentValue?: string | null
}

defineProps<{
  fields: AiResultField[]
}>()

const emit = defineEmits<{
  apply: []
  dismiss: []
}>()
</script>

<template>
  <UCard class="mb-4">
    <template #header>
      <div class="flex items-center">
        <UIcon name="i-lucide-sparkles" class="mr-2 size-4 text-primary" />
        <span class="font-medium">{{ t('ai.review.title') }}</span>
      </div>
    </template>

    <p class="mb-3 text-sm text-muted">
      {{ t('ai.review.description') }}
    </p>

    <div v-for="(field, index) in fields" :key="index" class="mb-4 last:mb-0">
      <div class="mb-1 text-xs font-medium text-muted">{{ field.label }}</div>
      <div class="rounded-md bg-elevated p-3 text-sm">
        {{ field.value }}
      </div>
      <div v-if="field.currentValue" class="mt-1 text-xs text-muted">
        {{ t('ai.review.currentValue') }}: {{ field.currentValue }}
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          :label="t('ai.review.dismiss')"
          variant="ghost"
          color="neutral"
          @click="emit('dismiss')"
        />
        <UButton
          :label="t('ai.review.apply')"
          color="primary"
          @click="emit('apply')"
        />
      </div>
    </template>
  </UCard>
</template>
