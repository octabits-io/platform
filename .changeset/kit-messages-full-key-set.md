---
"@octabits-io/nuxt-ui-kit": minor
---

`./i18n`: `KitMessages` now covers every namespace the kit actually reads.

The fragment documented itself as "the reference for the full key set" while
carrying four of them — `errors`, `auth`, `localeField`, `pageChrome`. The
components' own contracts (`dateInput.clear`, `dateRange.*`, `flexPeriod.*`,
`period.*`, `ai.review.*`) were missing, so a consumer that merged
`kitMessagesEn` and trusted the type still had to discover those keys by
watching a raw key path render in a date picker. All of them ship now, with
English defaults, and a test derives the required set from the component
sources so the type cannot drift from the components again.

**Type-level breaking for apps that build their own locales:** `KitMessages`
is exhaustive by design (that is what makes it a checklist), so a
`const de: KitMessages = { … }` object now fails to compile until the new
namespaces are translated. Spreading `kitMessagesEn` as a base is unaffected,
and no runtime behaviour changes.
