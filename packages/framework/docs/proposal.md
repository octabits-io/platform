# `./proposal` — the reviewable-outcome contract

```ts
import { buildProposal, proposeFields, resolveDecision } from '@octabits-io/framework/proposal';
import type { Proposal, ProposalDecision } from '@octabits-io/framework/proposal';
```

A workflow's result expressed as a **set of operations against data that already
exists** — not a value the caller has to interpret. Every operation that replaces
something carries what it replaces, captured on the server at emit time, so the
diff is a stored, auditable artifact rather than something a review screen
reconstructs by re-reading the entity in a browser.

Depends only on `zod`. Safe to import in a browser. Imports no other framework
module and no other module imports it (lint-enforced) — it is parked here until a
second consumer wants it under its own package name, and keeping it a leaf both
ways is what makes that extraction a path rename.

## Operations

Four, derived from a survey of real multi-step AI workflows rather than guessed:

| Op | What it carries | Why it exists |
|---|---|---|
| `update` | `target`, structured `path`, optional `variant` (e.g. locale), `current`, `proposed` | field values on an entity that exists, often across a second axis |
| `create` | `collection`, `ref`, `value`, optional `parent` anchor, optional `existing` | new rows, including whole trees whose parents are themselves new |
| `delete` | `target`, `current` | removal a reviewer must see as removal, not as an empty replacement |
| `reorder` | `collection`, `current[]`, `proposed[]` | ordered collections, where sequence is the meaning |

Two mechanisms fall out of that:

- **Pending anchors.** A `create` declares a `ref` valid only inside the proposal;
  anything may anchor to it (`pendingAnchor(ref)`), so a child can name a parent
  that has no id yet. `orderOperations` sorts creates before their dependents and
  reorders last; resolving refs to real ids is the applying host's job.
- **Derivation.** For a translation, "what this replaces" is nothing — the slot is
  empty. `derivedFrom` carries the *source* a reviewer needs to see instead.

## Around the operations

- `skipped[]` — what the run considered and did not propose, with `reason`
  (`SKIP_REASONS`) and optional `detail`. Real workflows partially fail.
- `provenance` — `model`, `keySource`, `costMicros`, `generatedAt`.
- `guard` on an update — a drift digest so a host can detect that the target
  moved between the run completing and the review happening.
- `display` — optional per-operation `label`/`labelKey`, `control`, `maxLength`,
  `hint`, `order`, so one generic renderer stands in for a bespoke review
  component per workflow.
- `applied` — set by the host once a decision is committed (`at`, `by`, `accepted`).

## Building one (server side)

```ts
const nextId = createIdFactory();
const proposal = buildProposal({
  scope: 'listing:88',
  operations: proposeFields({
    target: entityAnchor('listing', 88),
    variant: 'de',
    current: { title: 'Ferienwohnung Seeblick 3', excerpt: null },
    proposed: { title: 'Seeblick 3 — Balkon über dem Kochelsee', excerpt: 'Zwei Zimmer.' },
    display: { title: { control: 'text', maxLength: 120 } },
    nextId,
  }),
  skipped: [{ path: ['seoDescription'], reason: SKIP_REASONS.noOutput }],
  provenance: { model, keySource, costMicros },
});
validateProposal(proposal); // → ProposalIssue[]; empty when structurally sound
```

`proposeFields` drops fields the run reproduced unchanged, so a proposal only
ever contains real changes.

## Deciding (review side)

The review surface emits a `ProposalDecision`: the ids it `accepted`, plus
`edits` for values the reviewer changed before accepting. The host then runs

```ts
const ops = resolveDecision(proposal, decision); // ResolvedOperation[], ordered, `edited` flagged
const orphaned = danglingAfterDecision(proposal, decision); // children kept while their parent was rejected
```

and applies `ops` itself. **Applying and reverting are the host's job**; the
contract stores enough (`current`, `guard`, the decision) to make both auditable.

## Wire

`proposalSchema` and `proposalDecisionSchema` are zod schemas for both
directions. A proposal is defined against a step's **output schema**, never its
execution trace, so a step whose internals are a tool loop emits the same
proposal as a deterministic one.

## Consumers

- `@octabits-io/nuxt-ui-kit` — `components/ProposalReviewCard.vue` renders a
  proposal and emits a `ProposalDecision`.
- An engine (octaflow or otherwise) is one producer among many; nothing here
  depends on one.
