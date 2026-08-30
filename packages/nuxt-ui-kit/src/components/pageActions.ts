import type { InjectionKey, Ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

/**
 * A set of actions that are alternative ANSWERS to one question, collapsed
 * into a single inline control.
 *
 * The distinction it draws is between a bar that asks one thing and a bar that
 * asks several. Three buttons — "record yes", "record no", "record silence" —
 * are not three operations; they are one operation with three outcomes, and
 * rendered as peers they read as three independent things to do, indistinguish-
 * able from the unrelated tools beside them. Grouped, the bar asks the question
 * once and the answers live inside it.
 *
 * Use it ONLY for mutually exclusive outcomes. A pair like confirm/cancel that
 * an operator may legitimately reach for at different moments is two buttons,
 * not a group with two rows behind a chevron.
 *
 * Repeat the same descriptor object on every member (declare it once as a const
 * and reference it); the first member's copy defines the trigger and fixes the
 * group's position in the bar.
 */
export interface PageActionsGroup {
  /** Stable group identity. Doubles as the overflow-menu section id. */
  id: string;
  /** The question, as a verb phrase — "Record answer", "Close out". */
  label: string;
  /** Trigger icon. Falls back to the first member's. */
  icon?: string;
}

/**
 * Declarative page-header action. One array describes every action of a page —
 * inline buttons and overflow-menu items alike — and `PageActions` decides
 * placement from `visibility` and the available header width.
 */
export interface PageActionsItem {
  /** Stable identity (also the Vue key). */
  key: string;
  icon: string;
  label: string;
  /**
   * 'ai' renders the item in the AI cluster: sparkles + primary-soft (AiButton
   * styling). One inline AI item → verb-labeled button; several → a labeled
   * "AI ∨" dropdown. Collapsed AI items form their own menu group.
   */
  kind?: 'action' | 'ai';
  /** Menu-only helper text (shown in the AI dropdown / overflow rows). */
  description?: string;
  /** Inline button tone. At most ONE 'primary' item should be visible per state. */
  tone?: 'primary' | 'neutral';
  /**
   * Collapse this item into a shared decision control with its group siblings.
   *
   * Inline, the group renders as ONE outline trigger labeled `group.label` with
   * the members as rows — solid instead if any inline member carries
   * `tone: 'primary'`, so the one-solid-primary rule still holds and a grouped
   * beat still reads as the beat. A group with a single available member skips
   * the dropdown and renders that member as an ordinary button; a chevron
   * hiding one row is chrome pretending to be a choice.
   *
   * In the overflow menu the members are flat rows in a section of their own —
   * a submenu would bury an answer two levels deep.
   */
  group?: PageActionsGroup;
  /**
   * Placement tier:
   * - 'always' — inline at every width (the state's main action)
   * - 'auto'   — inline when the header is wide enough, else moved into the
   *              overflow menu (default)
   * - 'menu'   — overflow-menu only
   */
  visibility?: 'always' | 'auto' | 'menu';
  /**
   * Menu group id for 'menu' items (default 'default'). Groups render as
   * separated menu sections in first-appearance order; collapsed 'auto' items
   * form the leading group and utility items the trailing one. Convention:
   * put destructive rows in the last-declared section. Defaults to `group.id`
   * when the item belongs to a decision group, so grouped answers stay together
   * in the menu without restating the section.
   */
  section?: string;
  /** Menu-item color (e.g. 'error' for destructive rows). Inline tone wins inline. */
  color?: 'error' | 'warning';
  loading?: boolean;
  disabled?: boolean;
  /** Blocked-with-reason: renders disabled; inline buttons tooltip "label — reason". */
  disabledReason?: string | null;
  to?: RouteLocationRaw;
  target?: string;
  onSelect?: () => void;
}

/**
 * Current PageHeader content width in px, provided by `PageHeader` via a
 * ResizeObserver. `null` until first measurement (treated as wide).
 */
export const PAGE_HEADER_WIDTH: InjectionKey<Ref<number | null>> = Symbol('page-header-width');

/** Below this header width (px), 'auto' actions and utilities collapse into the menu. */
export const PAGE_ACTIONS_COLLAPSE_BELOW = 640;

/** One slot in the inline bar: a lone action, or a folded decision group. */
export type PageActionsInlineEntry =
  | { type: 'item'; item: PageActionsItem }
  | { type: 'group'; group: PageActionsGroup; items: PageActionsItem[] };

/** Whether an item renders inline at the current width. */
export function isInlineBound(item: PageActionsItem, collapsed: boolean): boolean {
  const visibility = item.visibility ?? 'auto';
  return visibility === 'always' || (visibility === 'auto' && !collapsed);
}

/**
 * The inline bar, in declaration order, with decision groups folded.
 *
 * Folded in a single pass over the original array rather than by partitioning
 * it, because a group's position in the bar is its FIRST member's — pulling
 * groups out and appending them would reorder the bar behind the caller's back.
 *
 * A group whose members are split across visibility tiers keeps only the
 * inline-bound ones, so a trigger never offers a row the state disallows; and a
 * group left with one member unwraps to an ordinary button, because a chevron
 * over a single row is chrome pretending to be a choice.
 *
 * Pure, and exported for its test — the SFC only renders what this returns.
 */
export function foldInlineActions(
  items: PageActionsItem[],
  collapsed: boolean,
): PageActionsInlineEntry[] {
  const entries: PageActionsInlineEntry[] = [];
  const groupAt = new Map<string, number>();
  for (const item of items) {
    if (!isInlineBound(item, collapsed)) continue;
    if (!item.group) {
      entries.push({ type: 'item', item });
      continue;
    }
    const at = groupAt.get(item.group.id);
    if (at == null) {
      groupAt.set(item.group.id, entries.length);
      entries.push({ type: 'group', group: item.group, items: [item] });
    } else {
      (entries[at] as Extract<PageActionsInlineEntry, { type: 'group' }>).items.push(item);
    }
  }
  return entries.map((entry) =>
    entry.type === 'group' && entry.items.length === 1
      ? { type: 'item' as const, item: entry.items[0]! }
      : entry,
  );
}

/**
 * Solid only if the group carries the state's primary, so folding a beat into a
 * group does not demote it and the one-solid-primary rule survives.
 */
export function groupIsPrimary(items: PageActionsItem[]): boolean {
  return items.some((item) => item.tone === 'primary');
}

/** What the current header width leaves inline. */
export interface PageActionsCollapseStages {
  /** 'auto' actions, utility items and Help are all in the ⋯ menu. */
  collapsed: boolean;
  /** Utility items and Help are in the ⋯ menu; actions are still inline. */
  utilitiesCollapsed: boolean;
}

/**
 * The ordered stages of loss as a header narrows: utilities first, then the
 * 'auto' actions, then (below everything) the header's own `flex-wrap`.
 *
 * `collapsed` implies `utilitiesCollapsed` by construction rather than by two
 * comparisons agreeing — a caller passing a utility threshold BELOW
 * `collapseBelow` would otherwise produce a bar that has dropped its optional
 * actions while still rendering the optional utilities beside them.
 *
 * A null width is pre-measurement and counts as wide: the first frame renders
 * everything and the ResizeObserver corrects it, rather than flashing a
 * collapsed bar on every mount.
 */
export function resolveCollapseStages(
  width: number | null,
  collapseBelow: number,
  utilityCollapseBelow?: number,
): PageActionsCollapseStages {
  if (width == null) return { collapsed: false, utilitiesCollapsed: false };
  const collapsed = width < collapseBelow;
  return {
    collapsed,
    utilitiesCollapsed: collapsed || width < (utilityCollapseBelow ?? collapseBelow),
  };
}

/**
 * The overflow menu's ACTION groups, in render order — everything above the
 * utility group, which the component builds itself (it needs i18n and the help
 * registry).
 *
 * The order is the whole point, and it is a convention the type cannot express:
 * destructive rows are the last-declared menu section, so anything appended
 * after the sections lands under "Delete". AI items used to, which read as an
 * afterthought to the deletion rather than as a thing you might do to the
 * record. They belong with the other collapsed actions instead.
 *
 * Groups render separated, and empty ones are dropped by the caller.
 */
export function buildMenuActionGroups(
  actionItems: PageActionsItem[],
  aiItems: PageActionsItem[],
  collapsed: boolean,
): PageActionsItem[][] {
  const visibilityOf = (item: PageActionsItem) => item.visibility ?? 'auto';

  // 'auto' actions the current width pushed out of the bar.
  const collapsedAutos = collapsed
    ? actionItems.filter(item => visibilityOf(item) === 'auto')
    : [];

  // Menu-only items, grouped by section in first-appearance order — so a
  // caller's declaration order decides, and 'destructive' stays last by
  // being declared last.
  const sections = new Map<string, PageActionsItem[]>();
  for (const item of actionItems) {
    if (visibilityOf(item) !== 'menu') continue;
    const section = item.section ?? item.group?.id ?? 'default';
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(item);
  }

  const aiGroup = aiItems.filter(item =>
    visibilityOf(item) === 'menu' || (visibilityOf(item) === 'auto' && collapsed),
  );

  return [collapsedAutos, aiGroup, ...sections.values()].filter(group => group.length > 0);
}
