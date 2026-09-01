---
'@octabits-io/nuxt-ui-kit': patch
---

`PageHeader density="compact"` now keeps its one-row promise when the title comes from the `#title` slot.

A wrap container places items by their hypothetical size, so a heading with `basis: auto` claimed its full content width and pushed the action cluster onto a second row before it was ever asked to shrink — the exact failure the prop path already fixed with `flex-1`. Measured on a record header with a slotted identity, three badges and five actions: 93px against the 53px the density delivers.

Slot content must be shrinkable (`min-w-0` + `truncate` on the text inside it). The baseline-aligned inline heading is unchanged.
