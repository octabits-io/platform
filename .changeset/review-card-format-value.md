---
"@octabits-io/nuxt-ui-kit": minor
---

`ProposalReviewCard` takes an optional `formatValue(value, operation)` prop: the host's one-line rendering of a structured value, used for the "Current" line of rich-text and JSON-shaped slots. Without it a document still falls back to its compact JSON — faithful, but a reviewer then sees the rich-text editor's document model as raw JSON above every rich-text field.
