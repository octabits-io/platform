<script setup lang="ts">
// Shipped as source: the consumer's Vite compiles this SFC. All imports are
// explicit — no reliance on the consumer's auto-import configuration.
// i18n key contract: pageChrome.help, pageChrome.ai (+ PageActionMenu's pageChrome.moreActions).
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import USeparator from '@nuxt/ui/components/Separator.vue';
import UDropdownMenu from '@nuxt/ui/components/DropdownMenu.vue';
import UIcon from '@nuxt/ui/components/Icon.vue';
import type { DropdownMenuItem } from '@nuxt/ui';
import AiButton from './AiButton.vue';
import PageAction from './PageAction.vue';
import PageActionMenu from './PageActionMenu.vue';
// Package-name import (not ../composables): only src/components is packed, and
// the dist-barrel Symbol instance must match the consumer's HELP_PANEL_KEY provider.
import { HELP_PANEL_KEY } from '@octabits-io/nuxt-ui-kit';
import { PAGE_ACTIONS_COLLAPSE_BELOW, PAGE_HEADER_WIDTH, type PageActionsItem } from './pageActions.ts';

/**
 * Width-aware page-header action cluster: one declarative list drives both the
 * inline buttons and the overflow menu. Wide headers render 'always' + 'auto'
 * items inline (all labeled, one solid primary max); below `collapseBelow`
 * only 'always' items stay inline and everything else — 'auto' items, utility
 * items, and the Help trigger — moves into the ⋯ menu, keeping its label.
 *
 * The Help trigger is rendered automatically when a `HELP_PANEL_KEY` registry
 * with registered actions is provided (replaces `PageUtilityActions` on pages
 * using this component — pass `:utility="false"` to `PageHeader`).
 */
const props = withDefaults(defineProps<{
  /** Entity actions (inline and/or menu, per `visibility`). */
  items: PageActionsItem[]
  /** Page-level utility triggers (e.g. "Ask about this booking"). Inline right
   *  of a separator when wide; bottom menu group when collapsed. */
  utilityItems?: PageActionsItem[]
  /** Header width (px) below which 'auto'/utility items collapse into the menu. */
  collapseBelow?: number
  /** Render the built-in Help trigger (when a help registry with actions is
   *  provided). Disable in nested/panel headers where the page-level header
   *  already owns Help. */
  help?: boolean
}>(), {
  utilityItems: () => [],
  collapseBelow: PAGE_ACTIONS_COLLAPSE_BELOW,
  help: true,
});

const { t } = useI18n();
const helpPanel = inject(HELP_PANEL_KEY, null);
const headerWidth = inject(PAGE_HEADER_WIDTH, null);

// null (no PageHeader provider / pre-measurement) counts as wide — the
// flex-wrap fallback keeps an unexpectedly narrow first frame usable.
const collapsed = computed(() => {
  const width = headerWidth?.value;
  return width != null && width < props.collapseBelow;
});

const showHelp = computed(() => props.help && Boolean(helpPanel?.hasActions.value));

const actionItems = computed(() => props.items.filter(item => (item.kind ?? 'action') !== 'ai'));
const aiItems = computed(() => props.items.filter(item => item.kind === 'ai'));

const isInlineBound = (item: PageActionsItem) =>
  (item.visibility ?? 'auto') === 'always'
  || ((item.visibility ?? 'auto') === 'auto' && !collapsed.value);

const inlineItems = computed(() => actionItems.value.filter(isInlineBound));

// AI cluster: one inline item renders as its own verb-labeled AiButton; several
// share a labeled "AI ∨" dropdown (icons + descriptions per row).
const inlineAiItems = computed(() => aiItems.value.filter(isInlineBound));
const aiDropdownItems = computed<DropdownMenuItem[]>(() =>
  inlineAiItems.value.map(item => ({
    label: item.label,
    description: item.description,
    icon: item.icon,
    disabled: item.disabled || Boolean(item.disabledReason),
    loading: item.loading,
    onSelect: item.onSelect,
  })),
);

const inlineUtilityItems = computed(() => collapsed.value ? [] : props.utilityItems);

// Descriptions render only in the dedicated AI dropdown (which has wrap/width
// styling) — the compact ⋯ overflow stays label-only.
function toMenuItem(item: PageActionsItem): DropdownMenuItem {
  return {
    label: item.label,
    icon: item.icon,
    color: item.color,
    disabled: item.disabled || Boolean(item.disabledReason),
    loading: item.loading,
    to: item.to,
    target: item.target,
    onSelect: item.onSelect,
  };
}

const menuGroups = computed<DropdownMenuItem[][]>(() => {
  const collapsedAutos = collapsed.value
    ? actionItems.value.filter(item => (item.visibility ?? 'auto') === 'auto')
    : [];

  // Menu-only items grouped by section, in first-appearance order.
  const sections = new Map<string, PageActionsItem[]>();
  for (const item of actionItems.value) {
    if ((item.visibility ?? 'auto') !== 'menu') continue;
    const section = item.section ?? 'default';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(item);
  }

  // AI items bound to the menu (explicit 'menu', or 'auto' while collapsed)
  // form their own group between the action sections and the utilities.
  const aiGroup = aiItems.value.filter(item =>
    (item.visibility ?? 'auto') === 'menu'
    || ((item.visibility ?? 'auto') === 'auto' && collapsed.value),
  );

  const utilityGroup: DropdownMenuItem[] = collapsed.value
    ? [
        ...props.utilityItems.map(toMenuItem),
        ...(showHelp.value && helpPanel
          ? [{ label: t('pageChrome.help'), icon: 'i-lucide-circle-help', onSelect: () => helpPanel.toggle() }]
          : []),
      ]
    : [];

  return [
    collapsedAutos.map(toMenuItem),
    ...[...sections.values()].map(group => group.map(toMenuItem)),
    aiGroup.map(toMenuItem),
    utilityGroup,
  ].filter(group => group.length > 0);
});

const hasUtilityRegion = computed(() =>
  inlineUtilityItems.value.length > 0 || (showHelp.value && !collapsed.value),
);
</script>

<template>
  <PageAction
    v-for="item in inlineItems"
    :key="item.key"
    :icon="item.icon"
    :label="item.label"
    show-label
    :tone="item.tone ?? 'neutral'"
    :loading="item.loading"
    :disabled="item.disabled"
    :disabled-reason="item.disabledReason"
    :to="item.to"
    :target="item.target"
    @click="item.onSelect?.()"
  />
  <!-- AI cluster: soft-primary sparkles = "AI acts on data". One item → its
       verb label; several → the shared labeled dropdown. -->
  <AiButton
    v-if="inlineAiItems.length === 1"
    :label="inlineAiItems[0]!.label"
    :loading="inlineAiItems[0]!.loading"
    :disabled="inlineAiItems[0]!.disabled || Boolean(inlineAiItems[0]!.disabledReason)"
    @click="inlineAiItems[0]!.onSelect?.()"
  />
  <UDropdownMenu
    v-else-if="inlineAiItems.length > 1"
    :items="aiDropdownItems"
    :content="{ align: 'end' }"
    :ui="{
      content: 'w-72',
      item: 'gap-2.5 p-2',
      itemLabel: 'font-medium text-highlighted',
      itemDescription: 'mt-0.5 whitespace-normal text-xs/4',
    }"
  >
    <AiButton :label="t('pageChrome.ai')" trailing-icon="i-lucide-chevron-down" />
    <template #item-leading="{ item }">
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-primary/20 ring-inset"
      >
        <UIcon :name="(item.icon as string) ?? 'i-lucide-sparkles'" class="size-4" />
      </span>
    </template>
  </UDropdownMenu>
  <PageActionMenu :items="menuGroups" />
  <template v-if="hasUtilityRegion">
    <USeparator orientation="vertical" class="h-5 mx-1" />
    <PageAction
      v-for="item in inlineUtilityItems"
      :key="item.key"
      :icon="item.icon"
      :label="item.label"
      show-label
      :loading="item.loading"
      :disabled="item.disabled"
      :to="item.to"
      :target="item.target"
      @click="item.onSelect?.()"
    />
    <PageAction
      v-if="showHelp && helpPanel"
      icon="i-lucide-circle-help"
      :label="t('pageChrome.help')"
      show-label
      @click="helpPanel.toggle()"
    />
  </template>
</template>
