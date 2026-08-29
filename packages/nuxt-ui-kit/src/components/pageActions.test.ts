import { describe, expect, it } from 'vitest';
import {
  foldInlineActions,
  groupIsPrimary,
  isInlineBound,
  resolveCollapseStages,
  type PageActionsGroup,
  type PageActionsItem,
} from './pageActions.ts';

/**
 * The rank between "inline button" and "buried in ⋯".
 *
 * Without a group the bar has exactly two inline weights — one solid primary
 * and N identical ghosts — so a set of alternative outcomes is indistinguish-
 * able from the unrelated tools beside it. These tests pin the folding, because
 * every property that makes a group readable (its position, what it swallows,
 * what it refuses to swallow) is silent when it breaks: the bar still renders,
 * it just renders wrong.
 */

const ANSWER: PageActionsGroup = { id: 'answer', label: 'Record answer', icon: 'i-lucide-reply' };
const CLOSEOUT: PageActionsGroup = { id: 'closeout', label: 'Close out' };

const item = (over: Partial<PageActionsItem> & { key: string }): PageActionsItem => ({
  icon: 'i-lucide-dot',
  label: over.key,
  ...over,
});

const keysOf = (entries: ReturnType<typeof foldInlineActions>) =>
  entries.map((entry) => (entry.type === 'group' ? `${entry.group.id}[${entry.items.map((i) => i.key).join(',')}]` : entry.item.key));

describe('isInlineBound', () => {
  it("keeps 'always' inline at every width and drops 'menu' at every width", () => {
    for (const collapsed of [false, true]) {
      expect(isInlineBound(item({ key: 'a', visibility: 'always' }), collapsed)).toBe(true);
      expect(isInlineBound(item({ key: 'm', visibility: 'menu' }), collapsed)).toBe(false);
    }
  });

  it("collapses 'auto' — the default — only when narrow", () => {
    expect(isInlineBound(item({ key: 'a' }), false)).toBe(true);
    expect(isInlineBound(item({ key: 'a' }), true)).toBe(false);
  });
});

describe('foldInlineActions', () => {
  it('folds group members into one entry at the FIRST member position', () => {
    // The group must not drift to the end of the bar: an operator reads the bar
    // left to right, and the caller's declaration order is the reading order.
    const entries = foldInlineActions([
      item({ key: 'publish', visibility: 'always' }),
      item({ key: 'yes', group: ANSWER, visibility: 'always' }),
      item({ key: 'tool' }),
      item({ key: 'no', group: ANSWER, visibility: 'always' }),
      item({ key: 'silence', group: ANSWER, visibility: 'always' }),
    ], false);

    expect(keysOf(entries)).toEqual(['publish', 'answer[yes,no,silence]', 'tool']);
  });

  it('keeps separate groups separate', () => {
    const entries = foldInlineActions([
      item({ key: 'yes', group: ANSWER, visibility: 'always' }),
      item({ key: 'departed', group: CLOSEOUT, visibility: 'always' }),
      item({ key: 'no', group: ANSWER, visibility: 'always' }),
      item({ key: 'no-show', group: CLOSEOUT, visibility: 'always' }),
    ], false);

    expect(keysOf(entries)).toEqual(['answer[yes,no]', 'closeout[departed,no-show]']);
  });

  it('unwraps a group left with one available member', () => {
    // A chevron over a single row is chrome pretending to be a choice — and the
    // unwrapped member must render as itself, keeping its own label and tone.
    const entries = foldInlineActions([
      item({ key: 'yes', group: ANSWER, visibility: 'always', tone: 'primary' }),
      item({ key: 'no', group: ANSWER, visibility: 'menu' }),
    ], false);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'item', item: { key: 'yes', tone: 'primary' } });
  });

  it('never offers a row the state disallows', () => {
    // A member the caller sent to the menu is not an answer the operator may
    // give — the trigger must not list it.
    const entries = foldInlineActions([
      item({ key: 'yes', group: ANSWER, visibility: 'always' }),
      item({ key: 'no', group: ANSWER, visibility: 'always' }),
      item({ key: 'silence', group: ANSWER, visibility: 'menu' }),
    ], false);

    expect(keysOf(entries)).toEqual(['answer[yes,no]']);
  });

  it("drops a whole group whose members are all 'auto' once collapsed", () => {
    // They reappear as flat menu rows (menuGroups keys their section off
    // group.id) rather than as a submenu — an answer two levels deep is buried.
    const items = [
      item({ key: 'yes', group: ANSWER }),
      item({ key: 'no', group: ANSWER }),
    ];
    expect(keysOf(foldInlineActions(items, false))).toEqual(['answer[yes,no]']);
    expect(foldInlineActions(items, true)).toEqual([]);
  });

  it('leaves ungrouped bars exactly as they were', () => {
    const items = [
      item({ key: 'confirm', tone: 'primary', visibility: 'always' }),
      item({ key: 'cancel' }),
      item({ key: 'archive', visibility: 'menu' }),
    ];
    expect(keysOf(foldInlineActions(items, false))).toEqual(['confirm', 'cancel']);
    expect(keysOf(foldInlineActions(items, true))).toEqual(['confirm']);
  });
});

describe('groupIsPrimary', () => {
  it('is solid when the group carries the beat, outline otherwise', () => {
    // Folding a beat into a group must not demote it — close-out IS what the
    // rail asks for, and it has to keep reading as the one solid button.
    expect(groupIsPrimary([item({ key: 'departed', tone: 'primary' }), item({ key: 'no-show' })])).toBe(true);
    // Nothing is due while an offer waits on the guest, so nothing shouts.
    expect(groupIsPrimary([item({ key: 'yes' }), item({ key: 'no' })])).toBe(false);
  });
});

describe('resolveCollapseStages', () => {
  const stages = (width: number | null) => resolveCollapseStages(width, 640, 880);

  it('drops the utilities before it drops any action', () => {
    // The band this exists for: wide enough that nothing used to collapse, too
    // narrow to fit — where the header silently wrapped instead.
    expect(stages(900)).toEqual({ collapsed: false, utilitiesCollapsed: false });
    expect(stages(700)).toEqual({ collapsed: false, utilitiesCollapsed: true });
    expect(stages(500)).toEqual({ collapsed: true, utilitiesCollapsed: true });
  });

  it('never leaves the utilities inline while the optional actions are gone', () => {
    // A caller passing a utility threshold BELOW collapseBelow would otherwise
    // produce exactly that bar. `collapsed` implies the utility stage.
    expect(resolveCollapseStages(500, 640, 300)).toEqual({ collapsed: true, utilitiesCollapsed: true });
  });

  it('treats a pre-measurement width as wide', () => {
    // Otherwise every mount flashes a collapsed bar before the observer fires.
    expect(resolveCollapseStages(null, 640, 880)).toEqual({ collapsed: false, utilitiesCollapsed: false });
  });

  it('is a no-op stage when no utility threshold is given', () => {
    for (const width of [500, 700, 900]) {
      const s = resolveCollapseStages(width, 640);
      expect(s.utilitiesCollapsed).toBe(s.collapsed);
    }
  });
});
