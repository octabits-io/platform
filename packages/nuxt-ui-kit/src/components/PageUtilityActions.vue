<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: pageChrome.help.
// Utility triggers stay LABELED buttons (not icon-only) by convention.
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import USeparator from '@nuxt/ui/components/Separator.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import { HELP_PANEL_KEY } from '@octabits-io/nuxt-ui-kit'

const { t } = useI18n()
const helpPanel = inject(HELP_PANEL_KEY, null)

const showHelp = computed(() => Boolean(helpPanel?.hasActions.value))
</script>

<template>
  <div v-if="showHelp" class="flex items-center gap-1">
    <USeparator orientation="vertical" class="h-5 mx-1" />
    <UButton
      v-if="helpPanel"
      icon="i-lucide-circle-help"
      :label="t('pageChrome.help')"
      size="sm"
      color="neutral"
      :variant="helpPanel.isOpen.value ? 'soft' : 'ghost'"
      @click="helpPanel.toggle()"
    />
  </div>
</template>
