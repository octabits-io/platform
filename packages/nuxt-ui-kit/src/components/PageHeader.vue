<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: pageChrome.back (+ PageActionMenu/PageUtilityActions keys).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import UButton from '@nuxt/ui/components/Button.vue'
import USkeleton from '@nuxt/ui/components/Skeleton.vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import PageActionMenu from './PageActionMenu.vue'
import PageUtilityActions from './PageUtilityActions.vue'

/**
 * Standard page header.
 *
 * Conventions enforced by this component and its siblings:
 * - EVERY inline `#actions` button is labeled (`show-label`) — no icon-only
 *   buttons in the header. Hierarchy comes from tone alone: at most ONE
 *   `tone="primary"` (solid) per state — the state's main next step — ghost
 *   neutral for the rest.
 * - Actions that are destructive only in *some* states (e.g. cancel) render
 *   inline while they are the state's decision counterpart, and move to the
 *   overflow menu (red) once they become destructive maintenance.
 * - Max 3 inline actions visible per state in `#actions`; more go in `overflowItems`.
 * - Destructive actions are ALWAYS placed inside the overflow menu, never inline.
 * - Header height, spacing, and tooltip behavior are normalized via `PageAction`.
 * - Utility triggers (Help, AI history, …) live in `#utility` (default =
 *   `PageUtilityActions`) and render as LABELED buttons, not icon-only.
 */
const props = withDefaults(defineProps<{
  title?: string
  subtitle?: string
  /** Show a leading back button. `true` uses router.back(); pass `{ to }` to navigate. */
  back?: boolean | { to: RouteLocationRaw }
  /** Show skeleton title while loading. */
  loading?: boolean
  /**
   * `default` = full-width top-of-page header with padding.
   * `compact` = sits inside a detail panel / sidebar; smaller title + thinner divider.
   * `flush`   = no padding/border (caller wraps it).
   */
  density?: 'default' | 'compact' | 'flush'
  /** When false, the default utility cluster is hidden. */
  utility?: boolean
  /** Optional grouped overflow items. Alternative to using the #overflow slot. */
  overflowItems?: DropdownMenuItem[][]
}>(), {
  back: false,
  loading: false,
  density: 'default',
  utility: true,
  overflowItems: () => [],
})

const { t } = useI18n()
const router = useRouter()

function onBack() {
  if (typeof props.back === 'object' && props.back && 'to' in props.back) {
    router.push(props.back.to)
    return
  }
  router.back()
}

const wrapperClass = computed(() => {
  switch (props.density) {
    case 'compact':
      return 'flex items-center gap-2 flex-wrap border-b border-default px-6 py-4'
    case 'flush':
      return 'flex items-center gap-2 flex-wrap'
    case 'default':
    default:
      return 'flex items-center gap-2 flex-wrap'
  }
})

const titleClass = computed(() => props.density === 'compact' ? 'font-display text-lg font-semibold tracking-tight' : 'font-display text-2xl font-semibold tracking-tight')
</script>

<template>
  <div :class="wrapperClass">
    <UButton
      v-if="back"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="t('pageChrome.back')"
      @click="onBack"
    />

    <div class="min-w-0">
      <slot name="title">
        <USkeleton v-if="loading" class="h-7 w-40" />
        <h1 v-else-if="title" :class="titleClass">{{ title }}</h1>
      </slot>
      <p v-if="subtitle && !loading" class="text-sm text-muted mt-1">{{ subtitle }}</p>
    </div>

    <div v-if="$slots.badges" class="flex items-center gap-2">
      <slot name="badges" />
    </div>

    <!-- flex-wrap: labeled actions overflow narrow (mobile) viewports otherwise —
         the outer header wraps rows, but this cluster must wrap internally too. -->
    <div class="ml-auto flex flex-wrap items-center gap-1">
      <slot name="actions" />
      <PageActionMenu
        v-if="overflowItems.length"
        :items="overflowItems"
      />
      <slot name="utility">
        <PageUtilityActions v-if="utility" />
      </slot>
    </div>
  </div>
</template>
