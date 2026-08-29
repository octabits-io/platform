---
'@octabits-io/nuxt-ui-kit': minor
---

PageActions: decision groups — fold mutually exclusive answers into one inline control

`PageActionsItem` gains an optional `group?: PageActionsGroup` descriptor. Items
sharing a group render inline as a single outline trigger labeled with the
question, with the members as dropdown rows; in the overflow menu they stay flat
rows in a section of their own.

The bar previously had exactly two inline weights — one solid primary and N
identical ghosts — so a set of alternative outcomes ("record yes / no / no
answer") was indistinguishable from the unrelated tools beside it. A group is
the rank between "inline button" and "buried in ⋯".

The trigger renders solid when any inline member carries `tone: 'primary'`, so
the one-solid-primary rule survives folding. A group with a single available
member unwraps to an ordinary button rather than a chevron over one row.

Additive and backwards compatible: items without `group` are unchanged.

**Also: `utilityCollapseBelow`** — an earlier collapse stage for the utility
region alone (utility items + the Help trigger), so a header that does not fit
sheds the things that change nothing before it sheds an action.

Below `collapseBelow` the fallback was `flex-wrap`, so between that threshold
and "actually fits" a crowded bar wrapped into two or three rows instead of
collapsing — silently, and dropping nothing, so the wrap point was arbitrary.
Defaults to `collapseBelow`, i.e. no separate stage and no change for any
caller that does not ask for one.
