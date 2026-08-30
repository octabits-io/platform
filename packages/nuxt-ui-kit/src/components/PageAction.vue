<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
import { computed, useSlots } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import UTooltip from '@nuxt/ui/components/Tooltip.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import type { ButtonProps } from '@nuxt/ui'

// Attrs are bound onto the BUTTON explicitly, never inherited by the root. The
// blocked branch's root is the tooltip, whose trigger is `as-child` — an
// inherited `@click` therefore landed on the hover span, and the disabled button
// beneath it is `pointer-events-none`, so every click on it reached the span and
// fired the parent's handler. A button that looks disabled must be disabled.
defineOptions({ inheritAttrs: false })

type Tone = 'primary' | 'neutral' | 'destructive'

/**
 * Normalized page-header action button: icon-only renders with a tooltip and
 * aria-label from the required `label`; a default slot or `showLabel` renders
 * the label text inline. `destructive` is only valid inside `PageActionMenu`.
 */
const props = withDefaults(defineProps<{
  /** Icon name (required). */
  icon: string
  /** Required. Used as tooltip text for icon-only buttons and aria-label otherwise. */
  label: string
  /** Visual tone. `destructive` is only valid inside PageActionMenu. */
  tone?: Tone
  loading?: boolean
  disabled?: boolean
  to?: RouteLocationRaw
  /** Link target, e.g. '_blank' for external links (only meaningful with `to`). */
  target?: string
  /** Force the button to render label text. If absent, a default slot determines it. */
  showLabel?: boolean
  /** Whether the tooltip should respect global disabled state. */
  tooltipDisabled?: boolean
  /**
   * Why the action is currently unavailable. When set, the button renders
   * disabled and the tooltip shows "label — reason", keeping the action's
   * purpose visible alongside the blocker. Hover on the disabled button works
   * via an internal span wrapper (disabled buttons don't dispatch pointer
   * events).
   */
  disabledReason?: string | null
}>(), {
  tone: 'neutral',
  loading: false,
  disabled: false,
  showLabel: false,
  tooltipDisabled: false,
  disabledReason: null,
})

const slots = useSlots()

const hasLabelSlot = computed(() => Boolean(slots.default))
const isIconOnly = computed(() => !hasLabelSlot.value && !props.showLabel)
const isBlocked = computed(() => Boolean(props.disabledReason))
const tooltipText = computed(() =>
  props.disabledReason ? `${props.label} — ${props.disabledReason}` : props.label,
)

const buttonProps = computed<Partial<ButtonProps>>(() => {
  const base: Partial<ButtonProps> = {
    icon: props.icon,
    // `md` (the Nuxt UI default) — header actions read at the same text size as
    // the buttons in the page body. `sm` renders text-xs, which looked shrunken
    // next to its own icon and next to every other button on the page.
    size: 'md',
    loading: props.loading,
    disabled: props.disabled || props.loading || isBlocked.value,
    to: props.to,
    target: props.target,
  }
  switch (props.tone) {
    case 'primary':
      return { ...base, color: 'primary', variant: 'solid' }
    case 'destructive':
      if (import.meta.dev) {
        console.warn('[PageAction] tone="destructive" should be used inside PageActionMenu, not inline.')
      }
      return { ...base, color: 'error', variant: 'ghost' }
    case 'neutral':
    default:
      return { ...base, color: 'neutral', variant: 'ghost' }
  }
})

if (import.meta.dev && !props.label) {
  console.warn('[PageAction] `label` is required (used as tooltip text for icon-only buttons).')
}
</script>

<template>
  <UTooltip
    v-if="isIconOnly || isBlocked"
    :text="tooltipText"
    :disabled="!isBlocked && tooltipDisabled"
  >
    <!-- Disabled buttons don't dispatch pointer events: when blocked, the span
         is the hover target and the button opts out of pointer events. -->
    <span v-if="isBlocked" class="inline-flex">
      <UButton
        v-bind="{ ...buttonProps, ...$attrs }"
        class="pointer-events-none"
        :aria-label="tooltipText"
        :label="!isIconOnly && showLabel ? label : undefined"
      >
        <slot v-if="!isIconOnly" />
      </UButton>
    </span>
    <UButton
      v-else
      v-bind="{ ...buttonProps, ...$attrs }"
      :aria-label="label"
    />
  </UTooltip>
  <UButton
    v-else
    v-bind="{ ...buttonProps, ...$attrs }"
    :label="showLabel ? label : undefined"
  >
    <slot />
  </UButton>
</template>
