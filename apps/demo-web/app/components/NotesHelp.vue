<script setup lang="ts">
/**
 * Help content for `/notes`, rendered inside `AppHelpPanel`.
 *
 * The props are the point: a registration hands the registry a component AND a
 * props object, and the page passes *reactive* values into it — the counts
 * below track the live filter without the panel knowing anything about it.
 */
import { useI18n } from 'vue-i18n'

defineProps<{
  shown: number
  total: number
  locales: string[]
}>()

const { t } = useI18n()
</script>

<template>
  <div class="flex flex-col gap-3 text-sm text-muted">
    <p>{{ t('notes.help.filter') }}</p>
    <p>{{ t('notes.help.counts', { shown, total }) }}</p>
    <p>{{ t('notes.help.locales', { locales: locales.join(', ').toUpperCase() }) }}</p>
  </div>
</template>
