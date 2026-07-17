---
"@octabits-io/nuxt-ui-kit": minor
---

i18n fragments are English-only: `kitMessagesDe` and `kitMessagesDeFormal` removed

The kit no longer ships translations beyond English. `kitMessagesEn` doubles as
the reference for the full key set; apps define their other locales themselves
as `KitMessages` objects, keeping every translation (and its register/voice)
app-side. Consumers of the removed German fragments should copy them into their
own locale files.
