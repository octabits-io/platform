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
- `applied` — set by the host once a decision is committed (`at`, `by`, `accepted`, `principal`).
- `principal` on `provenance` and on `applied` — who acted, for whom, under which
  grant (`{ kind, id, onBehalfOf?, authorizationId? }`). An agent is a principal,
  not a process: the audit row names both parties.
- `reversibility` on an operation — `reversible` (default: writing `current` back
  restores the world), `compensable` (the write reverts, a side effect does not),
  `irreversible` (nothing the host can write undoes it). `invertOperations`
  honours it and `reversibilityOf` gives the worst class for a ledger row.

## Building one (server side)

```ts
const nextId = createIdFactory();
const proposal = buildProposal({
  scope: 'article:88',
  operations: proposeFields({
    target: entityAnchor('article', 88),
    variant: 'de',
    current: { title: 'Erster Entwurf', excerpt: null },
    proposed: { title: 'Erster Entwurf, überarbeitet', excerpt: 'Zwei Absätze.' },
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

## Apply-side helpers (`apply.ts`)

Still pure, still zod-only — the parts every host would otherwise rewrite:

- `driftDigest(value)` — the digest a producer stores in an update's `guard`
  (`stableStringify` + cyrb53, same result in a browser and on a server) and
  the host recomputes over the live value at apply time.
- `detectDrift(operations, readCurrent)` — which accepted updates would
  overwrite something other than what the reviewer saw. `readCurrent` returns
  the live value or `undefined` for "cannot read" (skipped, not reported).
- `invertOperations(applied, createdIds)` — the operations that undo an
  application: updates swap `current`/`proposed` (the edited value is the new
  `current`), creates become deletes of the ids the host assigned, deletes
  become creates carrying `current` (with `existing` naming the original
  entity), reorders swap. Revert is a second proposal, computed from the
  audit row — never re-read from the entity.

## The recipe — what a host writes

The reference implementation is the demo server, end to end:

| Piece | Where | What it does |
|---|---|---|
| **Producer** | [`apps/demo-server/src/ai/workflows.ts`](../../../apps/demo-server/src/ai/workflows.ts) (`propose` step) | Re-reads the row at emit time so `current` is a fact about the run; `proposeFields` with `guard: driftDigest(current)`; a `create` whose value is the reviewer-editable body; `skipped[]` for what the model returned empty; `provenance`. The proposal is the step's **output schema**. |
| **Storage** | the workflow's own output (`output.propose`) | Nothing new to persist for the proposal itself — it is the run's outcome. |
| **Anchor → table mapping** | [`apps/demo-server/src/ai/proposals.ts`](../../../apps/demo-server/src/ai/proposals.ts) (`applyOperation`) | The one switch that knows `contact`/`brief` is `contactsService.update` and a `notes` create is a note whose title the host supplies. Everything else is generic. |
| **Apply** | same file (`apply`) + `POST /api/ai/workflows/:id/apply` | `validateProposal` → `resolveDecision` → `detectDrift` over the live row (409 `proposal_drift`) → writes in order → **audit row**. Refuses while an application stands. |
| **Ledger row** | [`./drizzle/agent-ledger`](./foundation.md#octabits-ioframeworkdrizzleagent-ledger), table in [`schema.ts`](../../../apps/demo-server/src/db/schema.ts) | Per application: the principal (agent, on behalf of whom, under which grant), mode, the decision, the resolved operations as written, the ids assigned to creates, the reversibility class, `applied_at`/`reverted_at`/`reverted_by`. `appliedAt` on the wire is projected from it through `createFlowWorkflowRoutes`' `extendWorkflow.load`. |
| **Revert** | same file (`revert`) + `POST …/revert` | `invertOperations` over the ledger row, written through the same `applyOperation`; `irreversible` operations are named, not undone. |
| **Review surface** | [`apps/demo-web/app/components/AiContactBrief.vue`](../../../apps/demo-web/app/components/AiContactBrief.vue) | The kit's `ProposalReviewCard.vue` renders `output.propose`; the decision it emits is posted as-is. |

What the demo leaves to a production host: one transaction around the writes
(these services take no `tx`), a real principal in `applied_by`, and per-scope
engine routing. What the contract does not yet do: field-level editing of a
`create` whose value is a row with several fields — the generic card shows JSON
for those.

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
