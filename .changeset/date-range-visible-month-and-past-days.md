---
'@octabits-io/nuxt-ui-kit': minor
---

feat(kit): DateRangeInput reports the month on screen, and marks days that are gone

`blockedDates` is a prop, so a parent can only ever have fetched a finite
window — but the calendar pages anywhere, and past the fetched edge a blocked
day renders as free. `DateRangeInput` now emits `visible-month` (the ISO first
day of the month) when a popover opens and on every navigation inside it, so
the parent can widen its fetch to what is actually being looked at.

Days before today are dimmed (`text-dimmed`) in both popovers, and a period
that lies entirely in the past says so under the inputs
(`dateRange.pastPeriod`, added to `kitMessagesEn`). Neither disables anything:
recording a stay that already happened is ordinary work — misreading which
year you are paging through is the mistake worth catching.
