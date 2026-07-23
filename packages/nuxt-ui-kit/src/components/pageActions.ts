import type { InjectionKey, Ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';

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
   * put destructive rows in the last-declared section.
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
