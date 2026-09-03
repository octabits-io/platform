/**
 * Building proposals, validating their structure, and resolving a reviewer's
 * answer back into the operations to commit.
 *
 * Pure functions over the types in `./types` — no engine, no store, no I/O.
 */
import type {
  Anchor,
  ChangeDisplay,
  CreateOperation,
  Derivation,
  EntityRef,
  JsonValue,
  Path,
  Proposal,
  ProposalDecision,
  ProposalIssue,
  ProposedOperation,
  ResolvedOperation,
  SkippedItem,
  UpdateOperation,
} from './types';

// ============================================================================
// Addressing helpers
// ============================================================================

/** `{ type: 'listing', id: '88' }` → `'listing:88'`. */
export function formatEntityRef(ref: Pick<EntityRef, 'type' | 'id'>): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * `'listing:88'` → `{ type: 'listing', id: '88' }`.
 *
 * Splits on the first colon only: ids legitimately contain colons (a composite
 * key, a URN), while a host's type names do not.
 */
export function parseEntityRef(ref: string): EntityRef | null {
  const at = ref.indexOf(':');
  if (at <= 0 || at === ref.length - 1) return null;
  return { type: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** An anchor to an entity that exists. */
export function entityAnchor(type: string, id: string | number, label?: string): Anchor {
  return label === undefined
    ? { kind: 'entity', type, id: String(id) }
    : { kind: 'entity', type, id: String(id), label };
}

/** An anchor to a `create` in the same proposal. */
export function pendingAnchor(ref: string, label?: string): Anchor {
  return label === undefined ? { kind: 'pending', ref } : { kind: 'pending', ref, label };
}

/** Stable string form of an anchor, for keys and comparisons. */
export function anchorKey(anchor: Anchor): string {
  return anchor.kind === 'entity' ? `@${anchor.type}:${anchor.id}` : `#${anchor.ref}`;
}

/**
 * Human-readable path — `['blocks', 2, 'title']` → `'blocks[2].title'`.
 *
 * For display and debugging only. Structural comparison uses `pathEqual`,
 * which never round-trips through a string.
 */
export function formatPath(path: Path): string {
  return path
    .map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join('');
}

export function pathEqual(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

// ============================================================================
// Value comparison
// ============================================================================

/** Structural equality for JSON values — order-sensitive for arrays, not for object keys. */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i] as JsonValue));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, JsonValue>;
    const bo = b as Record<string, JsonValue>;
    const aKeys = Object.keys(ao);
    if (aKeys.length !== Object.keys(bo).length) return false;
    return aKeys.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k] as JsonValue, bo[k] as JsonValue));
  }

  return false;
}

/** Treats `undefined`, `null` and `''` as "nothing there". */
export function isEmptyValue(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

// ============================================================================
// Operation builders
// ============================================================================

/** Mints operation ids that are unique within one proposal and stable in emit order. */
export function createIdFactory(prefix = 'op'): (hint?: string) => string {
  let n = 0;
  return (hint?: string) => {
    n += 1;
    return hint ? `${prefix}-${n}-${hint}` : `${prefix}-${n}`;
  };
}

export interface ProposeFieldsInput {
  /** What the values belong to. */
  target: Anchor;
  /**
   * What the target holds now, per field. A field the producer read and found
   * empty must appear here as `null` — omitting it is indistinguishable from
   * "never looked", and the whole contract turns on having looked.
   */
  current: Record<string, JsonValue>;
  /**
   * Proposed values per field. `undefined` means the run produced nothing for
   * that field and it is skipped entirely — distinct from `null`, which is a
   * proposal to clear.
   */
  proposed: Record<string, JsonValue | undefined>;
  /** Optional second axis these values belong to (a locale, a channel). */
  variant?: string;
  /** Per-field presentation metadata. */
  display?: Record<string, ChangeDisplay>;
  /** Per-field derivation, for values translated or normalized from a source. */
  derivedFrom?: Record<string, Derivation>;
  /** Per-field drift guard. */
  guard?: Record<string, string>;
  /** Cluster label for the review surface. */
  group?: string;
  /** Id minter — pass a shared one when composing several calls into a proposal. */
  nextId?: (hint?: string) => string;
}

/**
 * The flat-field case, which is the common one: diff proposed values against
 * current ones and emit an `update` for each field that actually changes.
 *
 * Dropping no-ops is not a tidiness measure — a review surface listing six
 * fields of which four are identical to what is already stored trains the
 * reviewer to accept without reading, which is the failure mode the whole
 * review step exists to prevent.
 *
 * Call once per variant and concatenate for a multi-axis run.
 */
export function proposeFields(input: ProposeFieldsInput): UpdateOperation[] {
  const { target, current, proposed, variant, display, derivedFrom, guard, group } = input;
  const nextId = input.nextId ?? createIdFactory();
  const ops: UpdateOperation[] = [];

  for (const [field, next] of Object.entries(proposed)) {
    if (next === undefined) continue;

    const now = Object.hasOwn(current, field) ? (current[field] as JsonValue) : null;
    if (jsonEqual(now, next)) continue;
    // Clearing a slot that is already empty changes nothing.
    if (next === null && isEmptyValue(now)) continue;

    const op: UpdateOperation = {
      id: nextId(variant ? `${field}-${variant}` : field),
      op: 'update',
      target,
      path: [field],
      current: now,
      proposed: next,
    };
    if (variant !== undefined) op.variant = variant;
    if (group !== undefined) op.group = group;
    const d = display?.[field];
    if (d) op.display = d;
    const from = derivedFrom?.[field];
    if (from) op.derivedFrom = from;
    const g = guard?.[field];
    if (g !== undefined) op.guard = g;
    ops.push(op);
  }

  return sortOperations(ops);
}

/** Orders by `display.order`, then by emit order. Stable. */
export function sortOperations<T extends ProposedOperation>(ops: T[]): T[] {
  return ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => {
      const ao = a.op.display?.order;
      const bo = b.op.display?.order;
      if (ao !== bo) {
        if (ao === undefined) return 1;
        if (bo === undefined) return -1;
        return ao - bo;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.op);
}

export interface ProposeCreateInput {
  collection: string;
  /** Handle other operations anchor to. Unique within the proposal. */
  ref: string;
  value: JsonValue;
  parent?: Anchor;
  existing?: EntityRef;
  display?: ChangeDisplay;
  derivedFrom?: Derivation;
  group?: string;
  id?: string;
}

/** A single `create`. */
export function proposeCreate(input: ProposeCreateInput): CreateOperation {
  const op: CreateOperation = {
    id: input.id ?? `create-${input.ref}`,
    op: 'create',
    collection: input.collection,
    ref: input.ref,
    value: input.value,
  };
  if (input.parent !== undefined) op.parent = input.parent;
  if (input.existing !== undefined) op.existing = input.existing;
  if (input.display !== undefined) op.display = input.display;
  if (input.derivedFrom !== undefined) op.derivedFrom = input.derivedFrom;
  if (input.group !== undefined) op.group = input.group;
  return op;
}

/**
 * A collection of new entities, each keyed by its own `ref`.
 *
 * The list case — "generate six canned responses", "bootstrap this catalogue"
 * — where the producer has values and no ids yet.
 */
export function proposeCreates(input: {
  collection: string;
  items: Array<{ ref: string; value: JsonValue; parent?: Anchor; existing?: EntityRef; display?: ChangeDisplay }>;
  group?: string;
  derivedFrom?: Derivation;
}): CreateOperation[] {
  return input.items.map((item) =>
    proposeCreate({
      collection: input.collection,
      ...item,
      ...(input.group !== undefined ? { group: input.group } : {}),
      ...(input.derivedFrom !== undefined ? { derivedFrom: input.derivedFrom } : {}),
    }),
  );
}

// ============================================================================
// Proposal assembly
// ============================================================================

export interface BuildProposalInput {
  scope: string;
  operations: ProposedOperation[];
  skipped?: SkippedItem[];
  workflowId?: number | string;
  workflowType?: string;
  provenance?: Proposal['provenance'];
}

/** Assemble a proposal. Starts unapplied. */
export function buildProposal(input: BuildProposalInput): Proposal {
  const proposal: Proposal = {
    scope: input.scope,
    operations: input.operations,
    applied: null,
  };
  if (input.skipped !== undefined && input.skipped.length > 0) proposal.skipped = input.skipped;
  if (input.workflowId !== undefined) proposal.workflowId = input.workflowId;
  if (input.workflowType !== undefined) proposal.workflowType = input.workflowType;
  if (input.provenance !== undefined) proposal.provenance = input.provenance;
  return proposal;
}

/** Whether a proposal has anything to review. */
export function isEmptyProposal(proposal: Proposal): boolean {
  return proposal.operations.length === 0;
}

// ============================================================================
// Slicing, for review surfaces
// ============================================================================

/** The distinct variants present, in first-seen order. Empty when there is no second axis. */
export function proposalVariants(proposal: Proposal): string[] {
  const seen: string[] = [];
  for (const op of proposal.operations) {
    const variant = op.op === 'update' ? op.variant : undefined;
    if (variant !== undefined && !seen.includes(variant)) seen.push(variant);
  }
  return seen;
}

/**
 * Operations belonging to one variant.
 *
 * Operations with no variant — every `create`, `delete` and `reorder`, and any
 * un-varianted update — are returned for **every** variant, because they are
 * not locale-specific and hiding them behind a tab a reviewer may never open
 * would drop them silently from the review.
 */
export function operationsForVariant(proposal: Proposal, variant?: string): ProposedOperation[] {
  if (variant === undefined) return proposal.operations;
  return proposal.operations.filter((op) => op.op !== 'update' || op.variant === undefined || op.variant === variant);
}

/** The distinct groups present, in first-seen order. */
export function proposalGroups(proposal: Proposal): string[] {
  const seen: string[] = [];
  for (const op of proposal.operations) {
    if (op.group !== undefined && !seen.includes(op.group)) seen.push(op.group);
  }
  return seen;
}

/** Operations in one group. */
export function operationsInGroup(proposal: Proposal, group: string): ProposedOperation[] {
  return proposal.operations.filter((op) => op.group === group);
}

/** Count by operation kind — for a review header that says what is about to happen. */
export function summarize(proposal: Proposal): Record<ProposedOperation['op'], number> {
  const counts = { update: 0, create: 0, delete: 0, reorder: 0 };
  for (const op of proposal.operations) counts[op.op] += 1;
  return counts;
}

// ============================================================================
// Structural validation
// ============================================================================

/** Every anchor an operation points at, including collection owners. */
function anchorsOf(op: ProposedOperation): Anchor[] {
  switch (op.op) {
    case 'update':
      return [op.target];
    case 'delete':
      return [op.target];
    case 'create':
      return op.parent ? [op.parent] : [];
    case 'reorder':
      return op.parent ? [op.parent] : [];
  }
}

/**
 * Check a proposal's internal structure: unique ids and refs, every pending
 * anchor resolved by a create in the same proposal, and no cycle among those
 * creates.
 *
 * Worth running where a proposal is produced rather than where it is applied.
 * An unresolved `pending` anchor is not a validation nicety — it is a tree
 * whose child cannot be written, discovered halfway through applying it.
 */
export function validateProposal(proposal: Proposal): ProposalIssue[] {
  const issues: ProposalIssue[] = [];

  const seenIds = new Set<string>();
  const declaredRefs = new Map<string, string>(); // ref → declaring operation id

  for (const op of proposal.operations) {
    if (seenIds.has(op.id)) {
      issues.push({ operationId: op.id, code: 'duplicate-id', message: `Duplicate operation id '${op.id}'.` });
    }
    seenIds.add(op.id);

    if (op.op === 'create') {
      if (declaredRefs.has(op.ref)) {
        issues.push({
          operationId: op.id,
          code: 'duplicate-ref',
          message: `Two creates declare ref '${op.ref}'.`,
        });
      }
      declaredRefs.set(op.ref, op.id);
    }

    if (op.op === 'reorder' && op.proposed.length === 0) {
      issues.push({ operationId: op.id, code: 'empty-reorder', message: 'Reorder proposes an empty sequence.' });
    }
  }

  // Every pending anchor must be declared by some create.
  for (const op of proposal.operations) {
    for (const anchor of anchorsOf(op)) {
      if (anchor.kind === 'pending' && !declaredRefs.has(anchor.ref)) {
        issues.push({
          operationId: op.id,
          code: 'unresolved-ref',
          message: `Anchors to pending ref '${anchor.ref}', which no create declares.`,
        });
      }
    }
    if (op.op === 'reorder') {
      // Members may name a pending ref; ids of existing members are opaque here.
      for (const member of op.proposed) {
        if (declaredRefs.has(member)) continue;
      }
    }
  }

  for (const id of detectCycle(proposal, declaredRefs)) {
    issues.push({ operationId: id, code: 'cycle', message: 'Create participates in a parent cycle.' });
  }

  return issues;
}

/** Ids of creates caught in a parent cycle. Empty when the parent graph is acyclic. */
function detectCycle(proposal: Proposal, declaredRefs: Map<string, string>): string[] {
  const creates = new Map<string, CreateOperation>();
  for (const op of proposal.operations) if (op.op === 'create') creates.set(op.ref, op);

  const state = new Map<string, 'visiting' | 'done'>();
  const bad = new Set<string>();

  const visit = (ref: string): boolean => {
    const seen = state.get(ref);
    if (seen === 'done') return false;
    if (seen === 'visiting') return true;

    const create = creates.get(ref);
    if (!create) return false;

    state.set(ref, 'visiting');
    const parent = create.parent;
    if (parent?.kind === 'pending' && declaredRefs.has(parent.ref) && visit(parent.ref)) {
      bad.add(create.id);
      state.set(ref, 'done');
      return true;
    }
    state.set(ref, 'done');
    return false;
  };

  for (const ref of creates.keys()) visit(ref);
  return [...bad];
}

/**
 * Order operations so a host can apply them in sequence: a create lands before
 * anything anchored to it, and reorders come last.
 *
 * Kahn's algorithm over the pending-ref graph. Operations in a cycle (which
 * `validateProposal` reports) are appended at the end rather than dropped, so
 * a caller that ignores validation still sees every operation.
 */
export function orderOperations(operations: ProposedOperation[]): ProposedOperation[] {
  const byRef = new Map<string, string>(); // pending ref → operation id
  for (const op of operations) if (op.op === 'create') byRef.set(op.ref, op.id);

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const op of operations) indegree.set(op.id, 0);

  for (const op of operations) {
    const deps: string[] = [];
    for (const anchor of anchorsOf(op)) {
      if (anchor.kind !== 'pending') continue;
      const producer = byRef.get(anchor.ref);
      if (producer !== undefined && producer !== op.id) deps.push(producer);
    }
    // A reorder naming pending members must follow their creates.
    if (op.op === 'reorder') {
      for (const member of op.proposed) {
        const producer = byRef.get(member);
        if (producer !== undefined && producer !== op.id) deps.push(producer);
      }
    }
    for (const dep of deps) {
      indegree.set(op.id, (indegree.get(op.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), op.id]);
    }
  }

  const byId = new Map(operations.map((op) => [op.id, op]));
  // Seed in emit order so the output is deterministic, not hash-ordered.
  const queue = operations.filter((op) => (indegree.get(op.id) ?? 0) === 0).map((op) => op.id);
  const out: ProposedOperation[] = [];
  const emitted = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (emitted.has(id)) continue;
    const op = byId.get(id);
    if (!op) continue;
    out.push(op);
    emitted.add(id);

    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  // Anything left is in a cycle — keep it, in emit order, at the end.
  for (const op of operations) if (!emitted.has(op.id)) out.push(op);

  // Reorders last: sequence is only meaningful once membership settles.
  return [...out.filter((op) => op.op !== 'reorder'), ...out.filter((op) => op.op === 'reorder')];
}

// ============================================================================
// Review resolution
// ============================================================================

/** The value an operation carries, for the kinds that carry one. */
function proposedValueOf(op: ProposedOperation): JsonValue | undefined {
  if (op.op === 'update') return op.proposed;
  if (op.op === 'create') return op.value;
  return undefined;
}

/** Same operation with an edited value folded in. */
function withValue(op: ProposedOperation, value: JsonValue): ProposedOperation {
  if (op.op === 'update') return { ...op, proposed: value };
  if (op.op === 'create') return { ...op, value };
  return op;
}

/**
 * Resolve a reviewer's decision into the operations to commit, applying any
 * edited values over what was proposed.
 *
 * Only ids present in `accepted` survive, and only if the proposal actually
 * contains them — an accept naming an operation the proposal never made is
 * dropped rather than trusted, since the decision arrives from a client.
 *
 * The result is ordered by `orderOperations`, so a host can apply it as it
 * stands without knowing which creates the rest depend on. Dropping a create
 * whose dependents were accepted is the caller's problem to notice — see
 * `danglingAfterDecision`.
 */
export function resolveDecision(proposal: Proposal, decision: ProposalDecision): ResolvedOperation[] {
  const accepted = new Set(decision.accepted);
  const edits = new Map((decision.edits ?? []).map((edit) => [edit.id, edit.value]));

  const resolved: ResolvedOperation[] = [];
  for (const op of proposal.operations) {
    if (!accepted.has(op.id)) continue;

    const original = proposedValueOf(op);
    const hasEdit = edits.has(op.id) && original !== undefined;
    const value = hasEdit ? (edits.get(op.id) as JsonValue) : undefined;
    const next = value !== undefined ? withValue(op, value) : op;

    resolved.push({
      ...next,
      edited: hasEdit && value !== undefined && original !== undefined && !jsonEqual(value, original),
    } as ResolvedOperation);
  }

  return orderOperations(resolved) as ResolvedOperation[];
}

/**
 * Accepted operations whose pending anchors were *not* accepted.
 *
 * A reviewer rejecting a parent while keeping its children is an ordinary
 * mistake in any tree review, and it produces operations that cannot be
 * applied. Surfacing them is better than either silently dropping the children
 * or failing halfway through the write.
 */
export function danglingAfterDecision(proposal: Proposal, decision: ProposalDecision): ProposedOperation[] {
  const accepted = new Set(decision.accepted);
  const acceptedRefs = new Set<string>();
  for (const op of proposal.operations) {
    if (op.op === 'create' && accepted.has(op.id)) acceptedRefs.add(op.ref);
  }

  return proposal.operations.filter((op) => {
    if (!accepted.has(op.id)) return false;
    return anchorsOf(op).some((anchor) => anchor.kind === 'pending' && !acceptedRefs.has(anchor.ref));
  });
}

/**
 * Record an application on a proposal, returning a new one — the original is
 * the record of what was proposed and is never mutated.
 */
export function markApplied(
  proposal: Proposal,
  application: { at: string; by: string; accepted: string[] },
): Proposal {
  return {
    ...proposal,
    applied: { at: application.at, by: application.by, accepted: [...application.accepted] },
  };
}
