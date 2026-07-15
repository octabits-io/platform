<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: pageChrome.moreActions.
import { useI18n } from 'vue-i18n'
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import PageAction from './PageAction.vue'

/**
 * Overflow/dropdown menu trigger that matches PageAction sizing. Accepts the
 * grouped `DropdownMenuItem[][]` shape. Destructive actions should set
 * `color: 'error'` on the item.
 */
withDefaults(defineProps<{
  items: DropdownMenuItem[][]
  icon?: string
  label?: string
}>(), {
  icon: 'i-lucide-ellipsis-vertical',
  label: undefined,
})

const { t } = useI18n()
</script>

<template>
  <UDropdownMenu v-if="items.length" :items="items">
    <PageAction
      :icon="icon"
      :label="label ?? t('pageChrome.moreActions')"
    />
  </UDropdownMenu>
</template>
