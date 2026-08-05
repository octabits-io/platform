---
'@octabits-io/nuxt-ui-kit': minor
---

DateRangeInput and FlexiblePeriodInput are now container-responsive for small/mobile widths. DateRangeInput stacks its two date inputs below 320px of own width (the arrow gives way to compact per-input labels); FlexiblePeriodInput drops the nights input + clear button to their own line below 512px, with the nights input gaining a compact label and full width when stacked.

Sizing contract change: both roots are now inline-size `@container`s, so their intrinsic width is 0. Parents must provide a definite width (block/grid context, `flex-1`, or an explicit `w-*`/`basis-*`) — shrink-to-fit parents (e.g. an unconstrained `flex flex-wrap` filter bar) will collapse them and need an explicit width on the wrapping field.
