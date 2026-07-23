---
"@octabits-io/nuxt-ui-kit": minor
---

AI trigger normalization: new `AiButton` primitive (sparkles + primary-soft + verb label — the single visual token for "AI acts on data"), and `PageActionsItem` gains `kind: 'ai'` + `description`. PageActions renders AI items as their own cluster: one inline item → verb-labeled AiButton, several → a labeled "AI ∨" dropdown (icons + descriptions per row, i18n key `pageChrome.ai`); collapsed AI items form their own group in the ⋯ menu.
