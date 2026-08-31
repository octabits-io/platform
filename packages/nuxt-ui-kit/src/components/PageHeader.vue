<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: pageChrome.back (+ PageActionMenu/PageUtilityActions keys).
import { computed, onBeforeUnmount, onMounted, provide, ref, useSlots } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import UButton from '@nuxt/ui/components/Button.vue'
import USkeleton from '@nuxt/ui/components/Skeleton.vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import PageActionMenu from './PageActionMenu.vue'
import PageUtilityActions from './PageUtilityActions.vue'
import { PAGE_HEADER_WIDTH } from './pageActions.ts'

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
 *
 * Prefer driving all of the above declaratively with `PageActions` (place it
 * in `#actions`, pass `:utility="false"`): it enforces the conventions and
 * collapses 'auto'/utility items into the ⋯ menu on narrow headers using the
 * width this component provides via `PAGE_HEADER_WIDTH`.
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
   * `compact` = sits inside a detail panel / sidebar; ONE row, and it means it —
   *             smaller title, the subtitle beside it rather than under it, and
   *             padding sized to the action buttons instead of to two text
   *             lines. It used to differ from `default` only in title size and
   *             still spent `py-4` on a stacked title/subtitle, which on a
   *             split-pane view is 85px of chrome that never scrolls away.
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
const slots = useSlots()

// Measured content width for PageActions' collapse decision. null until the
// first observation (treated as wide — the flex-wrap fallback covers it).
const wrapperEl = ref<HTMLElement | null>(null)
const headerWidth = ref<number | null>(null)
provide(PAGE_HEADER_WIDTH, headerWidth)

let observer: ResizeObserver | null = null
onMounted(() => {
  if (!wrapperEl.value || typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    headerWidth.value = entries[0]?.contentRect.width ?? null
  })
  observer.observe(wrapperEl.value)
})
onBeforeUnmount(() => observer?.disconnect())

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
      return 'flex items-center gap-2 flex-wrap border-b border-default px-6 py-2.5'
    case 'flush':
      return 'flex items-center gap-2 flex-wrap'
    case 'default':
    default:
      return 'flex items-center gap-2 flex-wrap'
  }
})

/**
 * `truncate` on the compact title for the same reason the subtitle has it: the
 * band is one row, and a title long enough to wrap makes it two — which is the
 * height the compact density exists to avoid. `min-w-0` is what lets it happen
 * at all inside the flex heading.
 */
const titleClass = computed(() => props.density === 'compact'
  ? 'min-w-0 truncate font-display text-base font-semibold tracking-tight'
  : 'font-display text-2xl font-semibold tracking-tight')

/**
 * Title and subtitle side by side, on `compact` only, and only when this
 * component is the one rendering them.
 *
 * A `#title` slot carries its own layout — the CMS detail panels put an icon
 * beside a two-line block — and a baseline-aligned flex row would re-align it
 * against text it does not contain. Slot users keep the plain wrapper they
 * were laid out against; the change is for the prop path, which is the one
 * that was stacking.
 */
const inlineHeading = computed(() => props.density === 'compact' && !slots.title)
/**
 * No wrapping, and a subtitle that shrinks before anything else does.
 *
 * The wrapper is `flex-wrap`, so without `min-w-0` + `truncate` a long
 * subtitle keeps its min-content width, wins the line, and pushes the action
 * cluster onto a second row — a compact band that ends up TALLER than the
 * stacked one it replaced (observed on the places page: 101px against 85).
 * Truncating is the right degradation here: `compact` promises one row, and a
 * subtitle long enough to truncate is help-panel material, not chrome.
 *
 * `flex-1` is the other half of that promise, and truncation alone does not
 * give it: a wrap container places items by their *hypothetical* size, which
 * for `truncate` (white-space: nowrap) is still the full text width — so the
 * heading was allowed to claim the line and the actions wrapped BEFORE the
 * subtitle was ever asked to shrink. `flex: 1 1 0%` makes the heading's
 * hypothetical size zero: it can never push a sibling onto a second row, and
 * it grows into whatever the action bar leaves.
 */
const headingClass = computed(() => inlineHeading.value
  ? 'flex min-w-0 flex-1 items-baseline gap-x-2'
  : 'min-w-0')
const subtitleClass = computed(() => inlineHeading.value
  ? 'text-sm text-muted min-w-0 truncate'
  : 'text-sm text-muted mt-1')
</script>

<template>
  <div ref="wrapperEl" :class="wrapperClass">
    <UButton
      v-if="back"
      icon="i-lucide-arrow-left"
      color="neutral"
      variant="ghost"
      size="md"
      :aria-label="t('pageChrome.back')"
      @click="onBack"
    />

    <!-- Skipped entirely when there is nothing to head with: a compact band
         may legitimately carry actions alone (the page title is already in the
         breadcrumb), and an empty box here would still take the `gap-2`. -->
    <div v-if="$slots.title || title || subtitle || loading" :class="headingClass">
      <slot name="title">
        <USkeleton v-if="loading" class="h-7 w-40" />
        <h1 v-else-if="title" :class="titleClass">{{ title }}</h1>
      </slot>
      <p v-if="subtitle && !loading" :class="subtitleClass">{{ subtitle }}</p>
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
