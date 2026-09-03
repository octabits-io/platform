---
"@octabits-io/framework": minor
"@octabits-io/nuxt-ui-kit": minor
---

Add `@octabits-io/framework/proposal` — the reviewable-outcome contract — and a
generic `ProposalReviewCard.vue` in the kit that renders it.

A workflow outcome expressed as a **set of operations against data that already
exists**, rather than a value the caller must interpret. `current` is mandatory
on anything that replaces something, and is captured on the server at emit
time, so the diff is a stored, auditable artifact rather than something a
review surface reconstructs by re-reading the entity in a browser.

Four operations, derived from a survey of real multi-step AI workflows rather
than guessed:

- **`update`** — field values on an existing entity, optionally across a second
  axis (`variant`) such as locale, addressed by a structured `path` that
  reaches leaves inside nested documents and arrays.
- **`create`** — new rows, including whole trees. A create declares a `ref`
  that other operations anchor to, so a child can name a parent that does not
  exist yet; `existing` marks a create the producer believes is really a link
  to something the host already has.
- **`delete`** — removal, carrying what is being removed.
- **`reorder`** — ordered collections, able to place pending creates among
  existing members.

Supporting pieces: `validateProposal`, `orderOperations`, `resolveDecision`,
`danglingAfterDecision`, `derivedFrom`, `guard` (drift digest), `skipped[]`,
optional `display` metadata, and zod schemas for both directions of the wire.

The module depends on nothing but zod, imports no other framework module, and
no other module imports it (lint-enforced as a leaf), so browsers can import it
and it can be lifted into its own package later without touching anything else.
It is deliberately **not** part of octaflow: a proposal is defined against a
step's output schema, never its execution trace, so any engine can emit one.

The kit's `ProposalReviewCard.vue` renders every operation kind, defaults to
accepting, and emits a `ProposalDecision`; it needs framework `>=0.36.0` (the
peer range moves accordingly) and ships its `ai.review.*` messages in
`kitMessagesEn`.
