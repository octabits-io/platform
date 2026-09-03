/**
 * The apply side of the contract — the pure parts of what a host does once a
 * decision exists. Applying itself is the host's job (it knows its tables);
 * these are the pieces every host would otherwise rewrite:
 *
 *   - `driftDigest` — the digest a producer stores in `guard` and a host
 *     recomputes over the live value at apply time. Same function both ends.
 *   - `detectDrift` — the check: which accepted updates no longer match what
 *     they promised to replace.
 *   - `invertOperations` — the plan that undoes an application, derived from
 *     the resolved operations and the ids the host assigned to creates. This
 *     is why `current` is mandatory: revert is a second proposal, computed.
 *
 * Still zod-only, still framework-free: nothing here touches a database.
 */
import type {
  CreateOperation,
  DeleteOperation,
  JsonValue,
  ProposedOperation,
  ReorderOperation,
  ResolvedOperation,
  UpdateOperation,
} from './types';

// ============================================================================
// Drift
// ============================================================================

/**
 * Canonical JSON: object keys sorted at every depth, so two structurally equal
 * values digest identically regardless of construction order. `undefined`
 * (an unreadable slot) and `null` (an empty one) both serialize as `null`.
 */
export function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * cyrb53 — a 53-bit non-cryptographic hash, rendered as 16 hex characters.
 * Drift detection needs a stable, cheap fingerprint that is the same in a
 * browser and on a server; it does not need collision resistance against an
 * adversary, which is why this is not SHA-256 behind an async API.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * The digest to store in an update's `guard` at emit time, and to recompute
 * over the live value at apply time.
 */
export function driftDigest(value: JsonValue | undefined): string {
  return cyrb53(stableStringify(value));
}

export interface DriftedOperation {
  operationId: string;
  /** The digest the proposal promised (`guard`). */
  expected: string;
  /** The digest of what the slot holds now. */
  actual: string;
}

/**
 * Which updates would overwrite something other than what the reviewer saw.
 *
 * `readCurrent` returns the slot's live value, or `undefined` when the host
 * cannot read it — those operations are skipped, not reported, since a
 * missing read is a host problem rather than a drift. Updates without a
 * `guard` are never checked; a producer that wants the check sets one.
 */
export function detectDrift(
  operations: readonly ProposedOperation[],
  readCurrent: (op: UpdateOperation) => JsonValue | undefined,
): DriftedOperation[] {
  const drifted: DriftedOperation[] = [];
  for (const op of operations) {
    if (op.op !== 'update' || op.guard === undefined) continue;
    const current = readCurrent(op);
    if (current === undefined) continue;
    const actual = driftDigest(current);
    if (actual !== op.guard) drifted.push({ operationId: op.id, expected: op.guard, actual });
  }
  return drifted;
}

// ============================================================================
// Revert
// ============================================================================

/** The ids a host assigned when it applied creates, by the create's `ref`. */
export type CreatedIds = Readonly<Record<string, string>>;

export interface InversePlan {
  /** Operations that undo the application, in the order to apply them (reverse of the original). */
  operations: ProposedOperation[];
  /** Creates that could not be inverted because no created id was recorded for their `ref`. */
  missing: string[];
}

/**
 * Derive the operations that undo an application.
 *
 * An update swaps `current` and `proposed` (the edited value, if the reviewer
 * changed it, is what was written and is therefore what `current` becomes).
 * A create becomes a delete of the row the host created, carrying the value
 * so the deletion is itself reviewable. A delete becomes a create carrying
 * `current`, with `existing` naming the original entity so a host that can
 * restore ids does. A reorder swaps its sequences.
 *
 * Guards are not carried over: the revert targets what the application
 * wrote, and whether that has since moved is a question the host asks with
 * `detectDrift` against the returned updates if it wants to.
 */
export function invertOperations(applied: readonly ResolvedOperation[], created: CreatedIds): InversePlan {
  const operations: ProposedOperation[] = [];
  const missing: string[] = [];

  for (let i = applied.length - 1; i >= 0; i--) {
    const op = applied[i]!;
    switch (op.op) {
      case 'update': {
        const inverse: UpdateOperation = {
          id: `revert-${op.id}`,
          op: 'update',
          target: op.target,
          path: op.path,
          current: op.proposed,
          proposed: op.current,
        };
        if (op.variant !== undefined) inverse.variant = op.variant;
        if (op.display !== undefined) inverse.display = op.display;
        operations.push(inverse);
        break;
      }
      case 'create': {
        const id = created[op.ref];
        if (id === undefined) {
          missing.push(op.ref);
          break;
        }
        const inverse: DeleteOperation = {
          id: `revert-${op.id}`,
          op: 'delete',
          target: { kind: 'entity', type: op.collection, id },
          current: op.value,
        };
        if (op.display !== undefined) inverse.display = op.display;
        operations.push(inverse);
        break;
      }
      case 'delete': {
        if (op.target.kind !== 'entity') break;
        const inverse: CreateOperation = {
          id: `revert-${op.id}`,
          op: 'create',
          collection: op.target.type,
          ref: `restore-${op.id}`,
          value: op.current,
          existing: { type: op.target.type, id: op.target.id },
        };
        if (op.display !== undefined) inverse.display = op.display;
        operations.push(inverse);
        break;
      }
      case 'reorder': {
        const inverse: ReorderOperation = {
          id: `revert-${op.id}`,
          op: 'reorder',
          collection: op.collection,
          current: op.proposed,
          proposed: op.current,
        };
        if (op.parent !== undefined) inverse.parent = op.parent;
        operations.push(inverse);
        break;
      }
    }
  }

  return { operations, missing };
}
