---
"@octabits-io/nuxt-ui-kit": minor
---

`LocaleInput` / `LocaleTextarea`: `placeholder` accepts a `LocaleMap<string>` beside a plain string, resolved for the active tab through the usual fallback chain (`resolveFieldPlaceholder`, exported from `./locale`). The `#ai` slot scope gains `activeLocale`, so a slotted action can write into the tab the operator is looking at.
