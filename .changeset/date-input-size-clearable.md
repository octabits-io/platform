---
"@octabits-io/nuxt-ui-kit": minor
---

`DateInput`: add `size` and `clearable`.

`size` forwards to the trigger button (the calendar popover itself never
shrinks — a hard-to-hit day cell is a worse trade than a tall button), so the
input can sit in a dense filter panel of `xs` controls without standing a head
taller than everything around it.

`clearable` puts an × beside the trigger once a date is set, emitting `''`. A
calendar can only ever PICK — clicking the selected day again re-selects it —
so until now there was no way back to "no date". That is fine for a required
field and wrong for anything optional, a filter bound above all. Off by
default, so existing required fields are unchanged.

Two `DateInput`s are also now the documented way to build an **open-ended**
range ("since March"); `DateRangeInput` models a stay and therefore wants both
bounds and at least one day between them.

New optional i18n key: `dateInput.clear` (falls back to "Clear" when absent).
