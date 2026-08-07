---
"@octabits-io/nuxt-ui-kit": patch
---

Render page-header actions at `md` instead of `sm`

`PageAction`, the built-in Help trigger, the ⋯ menu trigger, the back button and
the header AI cluster all rendered at Nuxt UI's `sm` size, i.e. `text-xs`. Next
to their own icons — and next to every `md`-sized button in the page body — the
labels read as shrunken. They now render at `md` (`text-sm`, the Nuxt UI
default), which keeps the same horizontal padding.

`AiButton` keeps its `sm` default for in-page triggers; only the header cluster
opts up.
