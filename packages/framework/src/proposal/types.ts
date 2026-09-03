/**
 * The proposal contract — a workflow's outcome expressed as a **reviewable set
 * of operations against data that already exists**, rather than as a value the
 * caller is expected to interpret.
 *
 * The distinction is the whole point. A step that returns
 * `{ title: 'Balcony above the lake' }` has told you what it produced; it has
 * not told you what that *replaces*, whether the slot was empty, what it cost,
 * which key paid for it, or which parts a person may accept without accepting
 * the rest. Every one of those is needed to render a review surface, and
 * without them each consumer reconstructs them by hand — usually by re-reading
 * the entity from the browser, at render time, once per workflow.
 *
 * A `Proposal` carries them as data, captured **at emit time on the server**,
 * so the diff is a stored artifact rather than a UI convenience. That is what
 * makes it auditable after the fact, and it is why `current` is mandatory on
 * every operation that replaces something.
 *
 * ## The rule that keeps this composable
 *
 * A proposal is defined against a step's **output schema**, never against its
 * execution trace. A handler that reaches the same values through a tool loop
 * emits exactly the same proposal as a deterministic one — so the review
 * surface neither knows nor cares how the graph ran, and a dynamic step stays
 * purely additive. Assemble a proposal from what a run *did* and you have
 * welded the review layer to the execution model.
 *
 * ## Shape, and why it is this shape
 *
 * The four operations are not a guess at what workflows might need. They are
 * what a survey of real multi-step AI workflows actually produces:
 *
 *   `update`   field values on an entity that exists, often across a second
 *              axis such as locale
 *   `create`   new rows — whole collections of them, sometimes forming a tree
 *              whose parents are themselves new
 *   `delete`   removal, which a reviewer must see as removal rather than as an
 *              empty replacement
 *   `reorder`  ordered collections, where sequence is the meaning
 *
 * Two mechanisms fall out of that and are worth naming up front:
 *
 * **Pending anchors.** A tree cannot be proposed as a flat list of creates,
 * because a child's parent does not exist yet and has no id to point at. A
 * `create` therefore declares its own `ref` — a handle valid only inside the
 * proposal — and anything may anchor to it. Resolving those handles to real
 * ids is the applying host's job; ordering the operations so it can is
 * `orderOperations`.
 *
 * **Derivation.** For a translation, "what this replaces" is nothing — the
 * slot is empty, which is why it is being filled. What a reviewer needs to see
 * is the *source* it was translated from. That is a different question than
 * `current`, so it gets a different field.
 *
 * This module depends on nothing but zod. It is imported by engines and by
 * browsers alike, and is deliberately independent of any one engine: the
 * review UI is its second consumer, and the engine that produced the run is
 * only its first.
 */

/** JSON-representable value. Proposals cross the wire and are persisted. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ============================================================================
// Addressing
// ============================================================================

/**
 * One step into a value. Strings index objects, numbers index arrays.
 *
 * A flat field name is the common case and stays a one-element path, but the
 * array form is what lets an operation address a leaf inside a structured
 * document — a section's third feature's caption — which flat dotted strings
 * cannot do without inventing an escaping rule for names containing dots.
 */
export type PathSegment = string | number;
export type Path = PathSegment[];

/** An entity that already exists, in the host's own addressing vocabulary. */
export interface EntityRef {
  /** Host's type name — `'listing'`, `'place'`, `'cannedResponse'`. */
  type: string;
  id: string;
  /** Human label, when the producer has one. Never load-bearing. */
  label?: string;
}

/**
 * What an operation points at: something that exists, or something this same
 * proposal is proposing to create.
 *
 * The second case is not an edge case — it is how any tree, nested structure,
 * or parent/child batch is expressed at all.
 */
export type Anchor =
  | ({ kind: 'entity' } & EntityRef)
  | { kind: 'pending'; ref: string; label?: string };

// ============================================================================
// Presentation
// ============================================================================

/**
 * How a reviewer should be shown a value. Optional, and deliberately
 * presentational — a headless consumer ignores it entirely.
 *
 * It lives in the contract because leaving it out is what forces every
 * consumer to maintain its own field table (label, control, limits) parallel
 * to the workflow that produces the values. Two tables, one truth, drifting.
 * The producer already knows a title is a short line with a hard cap and an
 * SEO description wants 150–160 characters; carrying that alongside the value
 * is what lets one generic renderer stand in for a bespoke review component
 * per workflow.
 */
export interface ChangeDisplay {
  /** Human label, when the producer has one. */
  label?: string;
  /** i18n key, preferred over `label` by consumers that localize. */
  labelKey?: string;
  /** Which control renders the value. Unknown kinds fall back to `text`. */
  control?: 'text' | 'multiline' | 'richtext' | 'number' | 'boolean' | 'list' | 'image' | 'json';
  /** Hard limit the consumer should enforce while editing. */
  maxLength?: number;
  /** Soft target range, shown as guidance rather than enforced. */
  hint?: { minLength?: number; maxLength?: number };
  /** Ordering within a group or variant. Lower sorts first; ties keep emit order. */
  order?: number;
}

/**
 * Where a proposed value came from, when that is something other than the
 * value it replaces.
 *
 * A translation is derived from a source locale; a normalized place is derived
 * from the raw location strings that were observed. In both cases `current` is
 * empty and useless to a reviewer, and this is what they actually need to see.
 */
export interface Derivation {
  /** What the source is — a locale tag, a source field name. */
  label?: string;
  /** Enough of the source to judge the result by. */
  preview?: string;
  /** Opaque host references to the source records this was built from. */
  refs?: string[];
}

// ============================================================================
// Who acted, and whether it can be undone
// ============================================================================

/**
 * The delegation chain on an agent action: who acted, for whom, under which
 * grant. This is what makes an agent a principal rather than a process — the
 * audit row names both parties honestly, and a grant can be revoked
 * independently of the agent and of the human's own session.
 *
 * A person acting directly is `{ kind: 'user', id }` with neither delegation
 * field. An agent acting under a grant carries both. `authorizationId` names
 * the host's grant record; the contract does not define what a grant contains.
 */
export interface Principal {
  kind: 'agent' | 'user' | 'system';
  id: string;
  label?: string;
  /** For an agent: the user whose grant it acted under. */
  onBehalfOf?: string;
  /** For an agent: the grant that permitted the action. */
  authorizationId?: string;
}

/**
 * Whether applying an operation can be undone by the contract's own means.
 *
 *   `reversible`    — writing `current` back restores the world. The default
 *                     for the four data operations, and what `invertOperations`
 *                     assumes.
 *   `compensable`   — the write itself reverts, but a side effect it triggered
 *                     does not (a notification went out); the inverse is a
 *                     correction, not an undo. Inverted, and flagged.
 *   `irreversible`  — nothing the host can write undoes it (a charge, a
 *                     message to a third party). Never inverted; an autonomy
 *                     ladder caps these at review.
 *
 * "Everything is reversible" is false on day one without this distinction.
 */
export type Reversibility = 'reversible' | 'compensable' | 'irreversible';

export const REVERSIBILITY = {
  reversible: 'reversible',
  compensable: 'compensable',
  irreversible: 'irreversible',
} as const;

// ============================================================================
// Operations
// ============================================================================

export interface OperationBase {
  /**
   * Stable identity within the proposal, and the unit of accept/reject.
   *
   * An explicit id rather than a derived path/variant key: `create` and
   * `reorder` have no path to derive one from, and a reviewer accepting "this
   * one" needs a handle that survives the values being edited.
   */
  id: string;
  /**
   * Optional cluster for the review surface — a section, a hierarchy level, a
   * locale group. Purely for presentation; nothing resolves through it.
   */
  group?: string;
  display?: ChangeDisplay;
  derivedFrom?: Derivation;
  /**
   * How the host's apply of this operation behaves. Absent means
   * `reversible` — the data operations are, unless the host's apply has side
   * effects it cannot take back. Producers set it when they know better.
   */
  reversibility?: Reversibility;
}

/** Change a value on something that exists (or on a pending create). */
export interface UpdateOperation extends OperationBase {
  op: 'update';
  target: Anchor;
  path: Path;
  /** Optional second axis over the same path — a locale, a channel, a size. */
  variant?: string;
  /**
   * What the target holds **now**, read on the server when the proposal was
   * built. `null` means the slot was empty — which is information a reviewer
   * needs ("this is a fill", not "this overwrites your copy").
   *
   * Mandatory by design. An operation that cannot state what it replaces is
   * not reviewable, and making the field optional would quietly re-admit the
   * client-side re-read this contract exists to remove.
   */
  current: JsonValue;
  proposed: JsonValue;
  /**
   * Drift guard: an opaque digest of the source this was derived from, or of
   * `current`, taken at emit time.
   *
   * A workflow completes asynchronously and may be reviewed much later, by
   * which time someone may have edited the target — at which point `current`
   * is stale and the diff quietly misleads. A host that carries a guard can
   * re-check it at apply time and refuse or warn instead.
   */
  guard?: string;
}

/** Bring a new entity into a collection. */
export interface CreateOperation extends OperationBase {
  op: 'create';
  /** Host's collection name — `'place'`, `'cannedResponse'`, `'pageBlock'`. */
  collection: string;
  /**
   * Handle other operations use to anchor to this not-yet-existing entity.
   * Unique within the proposal; meaningless outside it.
   */
  ref: string;
  /** Parent, for hierarchical creates. May itself be pending. */
  parent?: Anchor;
  value: JsonValue;
  /**
   * Set when the producer believes this matches something the host already
   * has, and the operation is really a link rather than an insert.
   *
   * Real workflows discover this constantly — a place hierarchy proposing a
   * city the tenant already stores. Without a slot for it, the producer's only
   * options are to drop the node (losing the tree) or to propose a duplicate.
   */
  existing?: EntityRef;
}

/** Remove something. */
export interface DeleteOperation extends OperationBase {
  op: 'delete';
  target: Anchor;
  /** What is being removed, so the reviewer sees what they are losing. */
  current: JsonValue;
}

/**
 * Change the sequence of an ordered collection.
 *
 * Members are named by host id or by a pending create's `ref`, so a reorder
 * can place newly-created members among existing ones — which is what any
 * "generate the sections of this page" workflow actually needs.
 */
export interface ReorderOperation extends OperationBase {
  op: 'reorder';
  collection: string;
  /** The collection's owner, when it hangs off an entity. */
  parent?: Anchor;
  current: string[];
  proposed: string[];
}

export type ProposedOperation =
  | UpdateOperation
  | CreateOperation
  | DeleteOperation
  | ReorderOperation;

// ============================================================================
// Proposal
// ============================================================================

/** Something the run considered and did not propose, and why. */
export interface SkippedItem {
  target?: Anchor;
  path?: Path;
  variant?: string;
  /**
   * Host-defined reason. `SKIP_REASONS` names the ones that recur; the field
   * stays a string because hosts legitimately have their own.
   */
  reason: string;
  detail?: string;
}

/**
 * Reasons that showed up independently across real workflows. Not exhaustive
 * and not enforced — a vocabulary, not a closed set.
 */
export const SKIP_REASONS = {
  /** The slot already had a value and the run was only filling gaps. */
  alreadyFilled: 'already_filled',
  /** The source moved after the run started; the derived value is stale. */
  sourceChanged: 'source_changed',
  /** The target no longer exists. */
  targetGone: 'target_gone',
  /** The model returned nothing usable for this item. */
  noOutput: 'no_output',
  /** The step failed for this item while succeeding for others. */
  failed: 'failed',
} as const;

/** Where a proposal's values came from, and what they cost. */
export interface ProposalProvenance {
  /** Model id that produced the values, when one did. */
  model?: string;
  /**
   * Estimated cost in **microdollars** (1 USD = 1_000_000), matching the unit
   * the AI layer's cost estimator already accumulates.
   */
  costMicros?: number;
  /**
   * Whose credentials paid. Free-form so hosts can name their own sources;
   * `'platform'` and `'tenant'` are the conventional two.
   */
  keySource?: string;
  /** When the run that produced these values completed (ISO 8601). */
  generatedAt?: string;
  /** Who produced the proposal — the agent, and the grant it ran under. */
  principal?: Principal;
}

/** The disposition of a proposal that has been acted on. */
export interface ProposalApplication {
  /** ISO 8601 timestamp of the apply. */
  at: string;
  /** Identifier of whoever applied it — a user id, an automation name. */
  by: string;
  /**
   * Who applied it, as a principal. On autopilot this is the agent again,
   * with `onBehalfOf` naming the human whose grant allowed it to skip review.
   */
  principal?: Principal;
  /**
   * Ids of the operations actually committed. A partial accept is the normal
   * case, so this is not derivable from the proposal.
   */
  accepted: string[];
}

/** A workflow outcome, as a reviewable set of operations. */
export interface Proposal {
  /**
   * What this proposal is *about*, in the host's own addressing vocabulary —
   * the same `entityRef` convention a workflow engine typically carries
   * (e.g. `"listing:88"`, `"tenant:acme"`).
   *
   * Scope is for routing and permissions; it does not constrain the
   * operations, which carry their own targets and may span many entities.
   */
  scope: string;
  /** The workflow run that produced it, for audit and for re-opening a review. */
  workflowId?: number | string;
  /** Workflow type, so a consumer can route to a specialized renderer if it has one. */
  workflowType?: string;
  operations: ProposedOperation[];
  /** What was considered and not proposed. Empty or absent when nothing was. */
  skipped?: SkippedItem[];
  provenance?: ProposalProvenance;
  /** `null` until someone accepts it. */
  applied?: ProposalApplication | null;
}

// ============================================================================
// Review
// ============================================================================

/**
 * A reviewer's answer: which operations to commit, and any values they edited
 * before committing.
 *
 * Edits are carried here rather than mutated into the proposal so the original
 * stays intact as the record of what was *proposed* — a proposal rewritten by
 * its own review has lost the audit trail it exists for.
 */
export interface ProposalDecision {
  /** Operation ids to commit. */
  accepted: string[];
  /**
   * Reviewer-edited values, by operation id. An id present here but absent
   * from `accepted` is ignored.
   *
   * These values come from a client and are therefore untrusted: validate them
   * against the producing step's output schema before committing.
   */
  edits?: Array<{ id: string; value: JsonValue }>;
}

/** One accepted operation, with any reviewer edit already folded in. */
export type ResolvedOperation = ProposedOperation & {
  /** True when the committed value differs from what was proposed. */
  edited: boolean;
};

/** A structural problem with a proposal, found by `validateProposal`. */
export interface ProposalIssue {
  /** Operation the problem is attached to, when it is local to one. */
  operationId?: string;
  code: 'duplicate-id' | 'duplicate-ref' | 'unresolved-ref' | 'cycle' | 'empty-reorder';
  message: string;
}
