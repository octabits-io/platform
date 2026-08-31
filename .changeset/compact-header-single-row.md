---
"@octabits-io/nuxt-ui-kit": patch
---

`PageHeader`: make `density="compact"` actually hold one row.

Truncating the subtitle (0.9.3) was only half the fix. A `flex-wrap` container
places its items by their *hypothetical* size, and for a `truncate`d line
(`white-space: nowrap`) that is still the full text width — so the heading was
allowed to claim the row and the action cluster wrapped onto a second one
*before* the subtitle was ever asked to shrink. The band that promises one row
still became two whenever the subtitle was long and the pane narrow (observed
in a ~600px detail pane in `apps/demo-web`).

The heading is now `flex: 1 1 0%`, whose hypothetical size is zero: it can
never push a sibling onto another row, and it grows into whatever the action
bar leaves. The compact title truncates too, for the same reason the subtitle
does — a title long enough to wrap makes the band the exact height `compact`
exists to avoid.

Only `density="compact"` is affected; `default` and `flush` are unchanged, as
are compact headers that fill the `#title` slot themselves.
