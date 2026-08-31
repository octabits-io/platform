<script setup lang="ts">
/**
 * Help content for `/contacts` — see `NotesHelp.vue` for why the props matter.
 */
import { useI18n } from 'vue-i18n'

defineProps<{ selected: string | null }>()

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-3 text-sm text-muted">
    <p>{{ t('contacts.help.search') }}</p>
    <p>{{ t('contacts.help.wish') }}</p>
    <p>{{ selected ? t('contacts.help.selected', { name: selected }) : t('contacts.help.noSelection') }}</p>
  </div>
</template>
