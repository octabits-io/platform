import { describe, expect, it } from 'vitest';
import { detectDrift, driftDigest, invertOperations, stableStringify } from './apply';
import { entityAnchor, resolveDecision, buildProposal, proposeFields } from './build';
import type { ResolvedOperation } from './types';

describe('stableStringify / driftDigest', () => {
  it('digests structurally equal values identically, regardless of key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: null, c: 'x' }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(driftDigest({ b: 1, a: 2 })).toBe(driftDigest({ a: 2, b: 1 }));
    expect(driftDigest('a')).not.toBe(driftDigest('b'));
  });

  it('treats an empty slot and an unreadable one the same, and differently from an empty string', () => {
    expect(driftDigest(null)).toBe(driftDigest(undefined));
    expect(driftDigest(null)).not.toBe(driftDigest(''));
    expect(driftDigest(null)).toHaveLength(16);
  });
});

describe('detectDrift', () => {
  const listing = entityAnchor('listing', 88);
  const ops = proposeFields({
    target: listing,
    current: { title: 'Old', excerpt: null },
    proposed: { title: 'New', excerpt: 'Fresh' },
    guard: { title: driftDigest('Old'), excerpt: driftDigest(null) },
  });

  it('reports only the updates whose live value no longer matches the guard', () => {
    const live: Record<string, string | null> = { title: 'Old', excerpt: 'Someone typed here' };
    const drifted = detectDrift(ops, (op) => live[String(op.path[0])]);

    expect(drifted.map((d) => d.operationId)).toEqual([ops.find((o) => o.path[0] === 'excerpt')!.id]);
    expect(drifted[0]!.expected).toBe(driftDigest(null));
    expect(drifted[0]!.actual).toBe(driftDigest('Someone typed here'));
  });

  it('skips slots the host cannot read, and updates without a guard', () => {
    expect(detectDrift(ops, () => undefined)).toEqual([]);
    const unguarded = ops.map((op) => ({ ...op, guard: undefined }));
    expect(detectDrift(unguarded, () => 'anything')).toEqual([]);
  });
});

describe('invertOperations', () => {
  it('undoes an application in reverse order, using the edited value as the new current', () => {
    const proposal = buildProposal({
      scope: 'listing:88',
      operations: [
        ...proposeFields({ target: entityAnchor('listing', 88), current: { title: 'Old' }, proposed: { title: 'New' } }),
        { id: 'c1', op: 'create', collection: 'notes', ref: 'n', value: 'body' },
        { id: 'd1', op: 'delete', target: entityAnchor('tag', 7), current: { name: 'old tag' } },
        { id: 'r1', op: 'reorder', collection: 'sections', current: ['a', 'b'], proposed: ['b', 'a'] },
      ],
    });
    const updateId = proposal.operations[0]!.id;
    const applied = resolveDecision(proposal, {
      accepted: proposal.operations.map((o) => o.id),
      edits: [{ id: updateId, value: 'Edited' }],
    });

    const { operations, missing } = invertOperations(applied, { n: 'note-123' });

    expect(missing).toEqual([]);
    // Exactly the reverse of the application order, one inverse per applied op.
    expect(operations.map((o) => o.id)).toEqual([...applied].reverse().map((o) => `revert-${o.id}`));
    const byOp = Object.fromEntries(operations.map((o) => [o.op, o]));
    expect(byOp.update).toMatchObject({ current: 'Edited', proposed: 'Old' });
    // The created note is deleted by the id the host assigned.
    expect(byOp.delete).toMatchObject({ target: { type: 'notes', id: 'note-123' }, current: 'body' });
    // The deleted tag comes back as a create that names the original entity.
    expect(byOp.create).toMatchObject({ collection: 'tag', existing: { type: 'tag', id: '7' }, value: { name: 'old tag' } });
    expect(byOp.reorder).toMatchObject({ current: ['b', 'a'], proposed: ['a', 'b'] });
    // Nothing carries a guard: the revert is checked against what was written, if at all.
    expect(operations.some((o) => 'guard' in o && o.guard !== undefined)).toBe(false);
  });

  it('reports creates it cannot invert instead of guessing an id', () => {
    const applied: ResolvedOperation[] = [
      { id: 'c1', op: 'create', collection: 'notes', ref: 'n', value: 'body', edited: false },
    ];
    expect(invertOperations(applied, {})).toEqual({ operations: [], missing: ['n'] });
  });
});
