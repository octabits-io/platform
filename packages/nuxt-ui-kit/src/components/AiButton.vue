<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
import UButton from '@nuxt/ui/components/Button.vue';

/**
 * THE visual token for AI triggers: sparkles + primary-soft + verb label.
 * Every button that launches AI work (workflow, generation, suggestion) renders
 * through this primitive so "AI will do something" always looks the same.
 * Convention: `i-lucide-sparkles` is reserved exclusively for AI triggers;
 * soft/solid primary = AI acts on data, ghost = AI conversation.
 */
withDefaults(defineProps<{
  label: string
  /** Leading icon. Keep the sparkles default unless a workflow icon is clearer. */
  icon?: string
  /** e.g. 'i-lucide-chevron-down' for dropdown triggers. */
  trailingIcon?: string
  size?: 'xs' | 'sm' | 'md'
  variant?: 'soft' | 'solid' | 'subtle' | 'outline' | 'ghost'
  loading?: boolean
  disabled?: boolean
}>(), {
  icon: 'i-lucide-sparkles',
  trailingIcon: undefined,
  size: 'sm',
  variant: 'soft',
  loading: false,
  disabled: false,
});
</script>

<template>
  <UButton
    :label="label"
    :icon="icon"
    :trailing-icon="trailingIcon"
    color="primary"
    :variant="variant"
    :size="size"
    :loading="loading"
    :disabled="disabled"
  />
</template>
