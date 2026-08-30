---
"@octabits-io/nuxt-ui-kit": patch
---

fix(kit): FlexiblePeriodInput's clear button no longer appears under the pointer — the first "+" on nights used to mount the X beside the input and shift the input left by one button, so the next click cleared the field. The X is now always in the layout and merely invisible until something is set. DateRangeInput caps each date field at 14rem when side by side (a date is a fixed-length value), and FlexiblePeriodInput keeps window, nights and clear together on the left instead of stretching the window across the row.
