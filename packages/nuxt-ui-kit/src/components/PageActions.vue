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
import UButton from '@nuxt/ui/components/Button.vue';
import {
  PAGE_ACTIONS_COLLAPSE_BELOW,
  PAGE_HEADER_WIDTH,
  foldInlineActions,
  groupIsPrimary,
  isInlineBound as isItemInlineBound,
  buildMenuActionGroups,
  resolveCollapseStages,
  type PageActionsItem,
} from './pageActions.ts';

/**
 * Width-aware page-header action cluster: one declarative list drives both the
 * inline buttons and the overflow menu. Wide headers render 'always' + 'auto'
 * items inline (all labeled, one solid primary max); below `collapseBelow`
 * only 'always' items stay inline and everything else — 'auto' items, utility
 * items, and the Help trigger — moves into the ⋯ menu, keeping its label.
 *
 * Items sharing a `group` fold into ONE inline control (see `PageActionsGroup`):
 * mutually exclusive answers to a single question stop competing for the bar as
 * peers. This is the only rank between "inline button" and "buried in ⋯" —
 * without it every neutral inline action is the same ghost weight, and a bar of
 * six says nothing about which one an operator reaches for.
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
  /**
   * Header width (px) below which ONLY the utility region (utility items + the
   * Help trigger) collapses into the menu, while every action stays inline.
   *
   * Exists because the fallback below `collapseBelow` is `flex-wrap`, and a bar
   * that does not fit therefore WRAPS rather than collapsing — silently, into
   * two or three rows, with the record's title stranded on a line of its own.
   * Between `collapseBelow` and "actually fits" that was the only behaviour
   * available, and it dropped nothing, so it chose the wrap point arbitrarily.
   *
   * A second threshold makes the loss ordered instead: utilities go first,
   * because they are the only things in the bar that change nothing — then the
   * 'auto' actions at `collapseBelow`, then the wrap. Set it per header from
   * what that header's widest state actually needs.
   *
   * Defaults to `collapseBelow`, i.e. no separate stage and no change for any
   * caller that does not ask for one.
   */
  utilityCollapseBelow?: number
  /** Render the built-in Help trigger (when a help registry with actions is
   *  provided). Disable in nested/panel headers where the page-level header
   *  already owns Help. */
  help?: boolean
}>(), {
  utilityItems: () => [],
  collapseBelow: PAGE_ACTIONS_COLLAPSE_BELOW,
  utilityCollapseBelow: undefined,
  help: true,
});

const { t } = useI18n();
const helpPanel = inject(HELP_PANEL_KEY, null);
const headerWidth = inject(PAGE_HEADER_WIDTH, null);

// null (no PageHeader provider / pre-measurement) counts as wide — the
// flex-wrap fallback keeps an unexpectedly narrow first frame usable.
const stages = computed(() =>
  resolveCollapseStages(headerWidth?.value ?? null, props.collapseBelow, props.utilityCollapseBelow),
);
const collapsed = computed(() => stages.value.collapsed);
const utilitiesCollapsed = computed(() => stages.value.utilitiesCollapsed);

const showHelp = computed(() => props.help && Boolean(helpPanel?.hasActions.value));

const actionItems = computed(() => props.items.filter(item => (item.kind ?? 'action') !== 'ai'));
const aiItems = computed(() => props.items.filter(item => item.kind === 'ai'));

const isInlineBound = (item: PageActionsItem) => isItemInlineBound(item, collapsed.value);

const inlineEntries = computed(() => foldInlineActions(actionItems.value, collapsed.value));

function toGroupMenuItem(item: PageActionsItem): DropdownMenuItem {
  return { ...toMenuItem(item), description: item.description };
}

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

const inlineUtilityItems = computed(() => utilitiesCollapsed.value ? [] : props.utilityItems);

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
  const utilityGroup: DropdownMenuItem[] = utilitiesCollapsed.value
    ? [
        ...props.utilityItems.map(toMenuItem),
        ...(showHelp.value && helpPanel
          ? [{ label: t('pageChrome.help'), icon: 'i-lucide-circle-help', onSelect: () => helpPanel.toggle() }]
          : []),
      ]
    : [];

  // Action groups (incl. their ORDER — see buildMenuActionGroups) are pure and
  // live in the module; the utilities need i18n and the help registry.
  return [
    ...buildMenuActionGroups(actionItems.value, aiItems.value, collapsed.value)
      .map(group => group.map(toMenuItem)),
    utilityGroup,
  ].filter(group => group.length > 0);
});

const hasUtilityRegion = computed(() =>
  inlineUtilityItems.value.length > 0 || (showHelp.value && !utilitiesCollapsed.value),
);

/**
 * Is there anything to the LEFT of the utility region for the separator to
 * separate it from? Everything the template renders before it, in order:
 * the inline actions, the AI cluster, and the overflow menu (which draws
 * nothing when its group list is empty).
 *
 * Without this the rule is drawn against the start of the cluster. A record
 * route that declares no actions — only the help registry — renders a bar
 * whose entire content is a vertical line and the Help button beside it, the
 * line dividing Help from nothing.
 */
const hasLeadingContent = computed(() =>
  inlineEntries.value.length > 0 || inlineAiItems.value.length > 0 || menuGroups.value.length > 0,
);
</script>

<template>
  <template v-for="entry in inlineEntries" :key="entry.type === 'group' ? entry.group.id : entry.item.key">
    <PageAction
      v-if="entry.type === 'item'"
      :icon="entry.item.icon"
      :label="entry.item.label"
      show-label
      :tone="entry.item.tone ?? 'neutral'"
      :loading="entry.item.loading"
      :disabled="entry.item.disabled"
      :disabled-reason="entry.item.disabledReason"
      :to="entry.item.to"
      :target="entry.item.target"
      @click="entry.item.onSelect?.()"
    />
    <!-- A decision group: one question, its answers inside. Outline rather
         than ghost — it is a decision, and the ghost tools beside it are not.
         Solid when it carries the state's primary. -->
    <UDropdownMenu
      v-else
      :items="[entry.items.map(toGroupMenuItem)]"
      :content="{ align: 'end' }"
      :ui="{
        content: 'w-64',
        item: 'gap-2.5 p-2',
        itemLabel: 'font-medium text-highlighted',
        itemDescription: 'mt-0.5 whitespace-normal text-xs/4',
      }"
    >
      <UButton
        :icon="entry.group.icon ?? entry.items[0]!.icon"
        :label="entry.group.label"
        size="md"
        :color="groupIsPrimary(entry.items) ? 'primary' : 'neutral'"
        :variant="groupIsPrimary(entry.items) ? 'solid' : 'outline'"
        trailing-icon="i-lucide-chevron-down"
      />
    </UDropdownMenu>
  </template>
  <!-- AI cluster: soft-primary sparkles = "AI acts on data". One item → its
       verb label; several → the shared labeled dropdown. `size="md"` matches
       PageAction — AiButton keeps its `sm` default for in-page triggers. -->
  <AiButton
    v-if="inlineAiItems.length === 1"
    :label="inlineAiItems[0]!.label"
    size="md"
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
    <AiButton :label="t('pageChrome.ai')" size="md" trailing-icon="i-lucide-chevron-down" />
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
    <USeparator v-if="hasLeadingContent" orientation="vertical" class="h-5 mx-1" />
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
      v-if="showHelp && !utilitiesCollapsed && helpPanel"
      icon="i-lucide-circle-help"
      :label="t('pageChrome.help')"
      show-label
      @click="helpPanel.toggle()"
    />
  </template>
</template>
