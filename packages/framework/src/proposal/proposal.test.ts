/**
 * Contract tests.
 *
 * Fixtures here are deliberately domain-neutral — `doc:1`, `field`, `item-a`.
 * The library is meant for a second consumer that is not the first one, and a
 * contract whose every example is one product's vocabulary reads as that
 * product's library however general the code underneath is. Real domain shapes
 * are exercised in `scenario.test.ts`, where they belong.
 */
import { describe, expect, it } from 'vitest';
import {
  anchorKey,
  buildProposal,
  createIdFactory,
  danglingAfterDecision,
  entityAnchor,
  formatEntityRef,
  formatPath,
  isEmptyProposal,
  jsonEqual,
  markApplied,
  operationsForVariant,
  operationsInGroup,
  orderOperations,
  parseEntityRef,
  pathEqual,
  pendingAnchor,
  proposalGroups,
  proposalVariants,
  proposeCreate,
  proposeCreates,
  proposeFields,
  resolveDecision,
  summarize,
  validateProposal,
} from './build';
import { proposalDecisionSchema, proposalSchema } from './schema';
import type { ProposedOperation } from './types';

const DOC = entityAnchor('doc', 1);

describe('addressing', () => {
  it('round-trips an entity ref', () => {
    expect(formatEntityRef({ type: 'doc', id: '1' })).toBe('doc:1');
    expect(parseEntityRef('doc:1')).toEqual({ type: 'doc', id: '1' });
  });

  it('splits on the first colon only, so ids may contain them', () => {
    expect(parseEntityRef('doc:urn:x:9')).toEqual({ type: 'doc', id: 'urn:x:9' });
  });

  it('rejects malformed refs rather than guessing', () => {
    expect(parseEntityRef('doc')).toBeNull();
    expect(parseEntityRef(':1')).toBeNull();
    expect(parseEntityRef('doc:')).toBeNull();
  });

  it('keeps entity and pending anchors in separate key spaces', () => {
    expect(anchorKey(entityAnchor('doc', 'x'))).not.toBe(anchorKey(pendingAnchor('doc:x')));
  });

  it('formats paths through objects and arrays', () => {
    expect(formatPath(['blocks', 2, 'title'])).toBe('blocks[2].title');
  });

  it('compares paths structurally, never by their string form', () => {
    expect(pathEqual(['a', 1], ['a', 1])).toBe(true);
    // '1' and 1 format identically but address different things.
    expect(pathEqual(['a', 1], ['a', '1'])).toBe(false);
  });
});

describe('jsonEqual', () => {
  it('compares nested structures by value', () => {
    expect(jsonEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true);
    expect(jsonEqual({ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] })).toBe(false);
  });

  it('ignores key order but respects array order', () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });

  it('does not treat null and empty string as equal', () => {
    expect(jsonEqual(null, '')).toBe(false);
  });
});

describe('proposeFields', () => {
  it('emits only fields that actually change', () => {
    const ops = proposeFields({
      target: DOC,
      current: { a: 'same', b: 'old' },
      proposed: { a: 'same', b: 'new' },
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'update', path: ['b'] });
  });

  it('records what it replaces on every operation', () => {
    const ops = proposeFields({ target: DOC, current: { a: 'old' }, proposed: { a: 'new' } });
    expect(ops[0]?.current).toBe('old');
  });

  it('treats a field absent from current as empty rather than unknown', () => {
    const ops = proposeFields({ target: DOC, current: {}, proposed: { a: 'new' } });
    expect(ops[0]?.current).toBeNull();
  });

  it('skips undefined but honours an explicit null as a clear', () => {
    const ops = proposeFields({
      target: DOC,
      current: { a: 'x', b: 'y' },
      proposed: { a: undefined, b: null },
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ path: ['b'], proposed: null });
  });

  it('does not propose clearing an already-empty slot', () => {
    expect(proposeFields({ target: DOC, current: { a: null }, proposed: { a: null } })).toEqual([]);
  });

  it('orders by display order, not object key order', () => {
    const ops = proposeFields({
      target: DOC,
      current: { a: null, b: null },
      proposed: { a: '1', b: '2' },
      display: { a: { order: 2 }, b: { order: 1 } },
    });

    expect(ops.map((o) => o.path[0])).toEqual(['b', 'a']);
  });

  it('carries a derivation for values that came from a source rather than a replacement', () => {
    const ops = proposeFields({
      target: DOC,
      current: { a: null },
      proposed: { a: 'translated' },
      derivedFrom: { a: { label: 'source', preview: 'original text' } },
    });

    expect(ops[0]?.derivedFrom).toMatchObject({ preview: 'original text' });
  });

  it('carries a drift guard when the producer supplies one', () => {
    const ops = proposeFields({
      target: DOC,
      current: { a: null },
      proposed: { a: 'x' },
      guard: { a: 'sha:abc' },
    });

    expect(ops[0]?.guard).toBe('sha:abc');
  });

  it('mints unique ids across variants when given a shared factory', () => {
    const nextId = createIdFactory();
    const one = proposeFields({ target: DOC, current: { a: null }, proposed: { a: '1' }, variant: 'x', nextId });
    const two = proposeFields({ target: DOC, current: { a: null }, proposed: { a: '2' }, variant: 'y', nextId });

    expect(one[0]?.id).not.toBe(two[0]?.id);
  });
});

describe('creates', () => {
  it('mints one operation per item, each with its own ref', () => {
    const ops = proposeCreates({
      collection: 'item',
      items: [
        { ref: 'item-a', value: { name: 'A' } },
        { ref: 'item-b', value: { name: 'B' } },
      ],
    });

    expect(ops.map((o) => o.ref)).toEqual(['item-a', 'item-b']);
    expect(ops.every((o) => o.op === 'create')).toBe(true);
  });

  it('records when a create is really a link to something that exists', () => {
    const op = proposeCreate({
      collection: 'item',
      ref: 'item-a',
      value: { name: 'A' },
      existing: { type: 'item', id: '7' },
    });

    expect(op.existing).toEqual({ type: 'item', id: '7' });
  });
});

describe('validateProposal', () => {
  it('passes a well-formed proposal', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'node', ref: 'root', value: { name: 'root' } }),
        proposeCreate({ collection: 'node', ref: 'child', value: { name: 'child' }, parent: pendingAnchor('root') }),
      ],
    });

    expect(validateProposal(proposal)).toEqual([]);
  });

  it('catches an anchor to a pending ref no create declares', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'node', ref: 'child', value: {}, parent: pendingAnchor('ghost') }),
      ],
    });

    expect(validateProposal(proposal)[0]).toMatchObject({ code: 'unresolved-ref' });
  });

  it('catches two creates claiming the same ref', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'node', ref: 'dup', value: {}, id: 'op-1' }),
        proposeCreate({ collection: 'node', ref: 'dup', value: {}, id: 'op-2' }),
      ],
    });

    expect(validateProposal(proposal).map((i) => i.code)).toContain('duplicate-ref');
  });

  it('catches duplicate operation ids', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'node', ref: 'a', value: {}, id: 'same' }),
        proposeCreate({ collection: 'node', ref: 'b', value: {}, id: 'same' }),
      ],
    });

    expect(validateProposal(proposal).map((i) => i.code)).toContain('duplicate-id');
  });

  it('catches a parent cycle', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'node', ref: 'a', value: {}, parent: pendingAnchor('b') }),
        proposeCreate({ collection: 'node', ref: 'b', value: {}, parent: pendingAnchor('a') }),
      ],
    });

    expect(validateProposal(proposal).map((i) => i.code)).toContain('cycle');
  });

  it('catches a reorder proposing nothing', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: [
        { id: 'r', op: 'reorder', collection: 'item', current: ['a'], proposed: [] } as ProposedOperation,
      ],
    });

    expect(validateProposal(proposal).map((i) => i.code)).toContain('empty-reorder');
  });
});

describe('orderOperations', () => {
  it('puts a create before anything anchored to it, whatever order they arrive in', () => {
    const ops: ProposedOperation[] = [
      proposeCreate({ collection: 'node', ref: 'child', value: {}, parent: pendingAnchor('root'), id: 'c' }),
      proposeCreate({ collection: 'node', ref: 'root', value: {}, id: 'r' }),
    ];

    expect(orderOperations(ops).map((o) => o.id)).toEqual(['r', 'c']);
  });

  it('orders a three-deep chain', () => {
    const ops: ProposedOperation[] = [
      proposeCreate({ collection: 'n', ref: 'c', value: {}, parent: pendingAnchor('b'), id: '3' }),
      proposeCreate({ collection: 'n', ref: 'b', value: {}, parent: pendingAnchor('a'), id: '2' }),
      proposeCreate({ collection: 'n', ref: 'a', value: {}, id: '1' }),
    ];

    expect(orderOperations(ops).map((o) => o.id)).toEqual(['1', '2', '3']);
  });

  it('places a reorder after the creates of the members it names', () => {
    const ops: ProposedOperation[] = [
      { id: 'order', op: 'reorder', collection: 'block', current: [], proposed: ['b1', 'b2'] },
      proposeCreate({ collection: 'block', ref: 'b1', value: {}, id: 'mk-b1' }),
      proposeCreate({ collection: 'block', ref: 'b2', value: {}, id: 'mk-b2' }),
    ];

    const ordered = orderOperations(ops).map((o) => o.id);
    expect(ordered.indexOf('order')).toBeGreaterThan(ordered.indexOf('mk-b2'));
  });

  it('keeps cyclic operations rather than dropping them', () => {
    const ops: ProposedOperation[] = [
      proposeCreate({ collection: 'n', ref: 'a', value: {}, parent: pendingAnchor('b'), id: 'a' }),
      proposeCreate({ collection: 'n', ref: 'b', value: {}, parent: pendingAnchor('a'), id: 'b' }),
    ];

    expect(orderOperations(ops)).toHaveLength(2);
  });

  it('is deterministic for independent operations', () => {
    const ops: ProposedOperation[] = [
      proposeCreate({ collection: 'n', ref: 'x', value: {}, id: '1' }),
      proposeCreate({ collection: 'n', ref: 'y', value: {}, id: '2' }),
    ];

    expect(orderOperations(ops).map((o) => o.id)).toEqual(['1', '2']);
  });
});

describe('slicing', () => {
  const nextId = createIdFactory();
  const proposal = buildProposal({
    scope: 'doc:1',
    operations: [
      ...proposeFields({ target: DOC, current: { a: null }, proposed: { a: 'x' }, variant: 'one', nextId, group: 'g1' }),
      ...proposeFields({ target: DOC, current: { a: null }, proposed: { a: 'y' }, variant: 'two', nextId, group: 'g1' }),
      proposeCreate({ collection: 'item', ref: 'i1', value: {}, group: 'g2' }),
    ],
  });

  it('lists variants in first-seen order', () => {
    expect(proposalVariants(proposal)).toEqual(['one', 'two']);
  });

  it('includes un-varianted operations in every variant, so nothing hides behind a tab', () => {
    const one = operationsForVariant(proposal, 'one');
    expect(one.map((o) => o.id)).toContain('create-i1');
    expect(one).toHaveLength(2);
  });

  it('lists and slices groups', () => {
    expect(proposalGroups(proposal)).toEqual(['g1', 'g2']);
    expect(operationsInGroup(proposal, 'g2')).toHaveLength(1);
  });

  it('summarizes what is about to happen', () => {
    expect(summarize(proposal)).toEqual({ update: 2, create: 1, delete: 0, reorder: 0 });
  });
});

describe('resolveDecision', () => {
  const proposal = buildProposal({
    scope: 'doc:1',
    operations: [
      proposeCreate({ collection: 'item', ref: 'i1', value: { name: 'A' }, id: 'mk' }),
      ...proposeFields({ target: DOC, current: { a: 'old' }, proposed: { a: 'new' }, nextId: () => 'up' }),
    ],
  });

  it('commits only accepted operations', () => {
    expect(resolveDecision(proposal, { accepted: ['up'] }).map((o) => o.id)).toEqual(['up']);
  });

  it('drops an accept naming an operation the proposal never made', () => {
    expect(resolveDecision(proposal, { accepted: ['ghost'] })).toEqual([]);
  });

  it('applies an edit to an update and flags it', () => {
    const [op] = resolveDecision(proposal, { accepted: ['up'], edits: [{ id: 'up', value: 'edited' }] });
    expect(op).toMatchObject({ edited: true });
    expect(op?.op === 'update' && op.proposed).toBe('edited');
  });

  it('applies an edit to a create value too', () => {
    const [op] = resolveDecision(proposal, { accepted: ['mk'], edits: [{ id: 'mk', value: { name: 'B' } }] });
    expect(op?.op === 'create' && op.value).toEqual({ name: 'B' });
  });

  it('does not flag an edit that matches what was proposed', () => {
    const [op] = resolveDecision(proposal, { accepted: ['up'], edits: [{ id: 'up', value: 'new' }] });
    expect(op?.edited).toBe(false);
  });

  it('ignores an edit for an operation that was not accepted', () => {
    const resolved = resolveDecision(proposal, { accepted: ['up'], edits: [{ id: 'mk', value: {} }] });
    expect(resolved.map((o) => o.id)).toEqual(['up']);
  });

  it('returns operations in applicable order', () => {
    const tree = buildProposal({
      scope: 'doc:1',
      operations: [
        proposeCreate({ collection: 'n', ref: 'child', value: {}, parent: pendingAnchor('root'), id: 'c' }),
        proposeCreate({ collection: 'n', ref: 'root', value: {}, id: 'r' }),
      ],
    });

    expect(resolveDecision(tree, { accepted: ['c', 'r'] }).map((o) => o.id)).toEqual(['r', 'c']);
  });

  it('leaves the proposal untouched', () => {
    const before = JSON.stringify(proposal);
    resolveDecision(proposal, { accepted: ['up'], edits: [{ id: 'up', value: 'edited' }] });
    expect(JSON.stringify(proposal)).toBe(before);
  });
});

describe('danglingAfterDecision', () => {
  const tree = buildProposal({
    scope: 'doc:1',
    operations: [
      proposeCreate({ collection: 'n', ref: 'root', value: {}, id: 'r' }),
      proposeCreate({ collection: 'n', ref: 'child', value: {}, parent: pendingAnchor('root'), id: 'c' }),
    ],
  });

  it('reports a child kept while its parent was rejected', () => {
    expect(danglingAfterDecision(tree, { accepted: ['c'] }).map((o) => o.id)).toEqual(['c']);
  });

  it('reports nothing when the parent came along', () => {
    expect(danglingAfterDecision(tree, { accepted: ['r', 'c'] })).toEqual([]);
  });
});

describe('markApplied', () => {
  it('returns a new proposal, leaving the original as the record of what was proposed', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: proposeFields({ target: DOC, current: { a: 'x' }, proposed: { a: 'y' } }),
    });

    const applied = markApplied(proposal, { at: '2026-09-03T09:14:22Z', by: 'reviewer', accepted: ['op-1'] });

    expect(proposal.applied).toBeNull();
    expect(applied.applied).toMatchObject({ by: 'reviewer' });
    expect(applied.operations).toBe(proposal.operations);
  });
});

describe('schema', () => {
  it('accepts all four operation kinds in one document', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      workflowId: 1,
      operations: [
        ...proposeFields({ target: DOC, current: { a: 'x' }, proposed: { a: 'y' } }),
        proposeCreate({ collection: 'item', ref: 'i1', value: { name: 'A' } }),
        { id: 'del', op: 'delete', target: DOC, current: { gone: true } },
        { id: 'ord', op: 'reorder', collection: 'item', current: ['a'], proposed: ['i1', 'a'] },
      ],
      skipped: [{ reason: 'already_filled', path: ['b'] }],
      provenance: { model: 'test-model', costMicros: 1234, keySource: 'platform' },
    });

    expect(proposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('rejects an update that omits what it replaces', () => {
    const bad = {
      scope: 'doc:1',
      operations: [{ id: 'x', op: 'update', target: DOC, path: ['a'], proposed: 'y' }],
    };

    expect(proposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown operation kind rather than passing it through', () => {
    const bad = { scope: 'doc:1', operations: [{ id: 'x', op: 'upsert', target: DOC }] };
    expect(proposalSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty path', () => {
    const bad = {
      scope: 'doc:1',
      operations: [{ id: 'x', op: 'update', target: DOC, path: [], current: null, proposed: 'y' }],
    };

    expect(proposalSchema.safeParse(bad).success).toBe(false);
  });

  it('validates a decision payload arriving from a client', () => {
    expect(
      proposalDecisionSchema.safeParse({ accepted: ['a'], edits: [{ id: 'a', value: 'x' }] }).success,
    ).toBe(true);
    expect(proposalDecisionSchema.safeParse({ accepted: [''] }).success).toBe(false);
  });
});

describe('isEmptyProposal', () => {
  it('is true when nothing actually changed', () => {
    const proposal = buildProposal({
      scope: 'doc:1',
      operations: proposeFields({ target: DOC, current: { a: 'same' }, proposed: { a: 'same' } }),
    });

    expect(isEmptyProposal(proposal)).toBe(true);
  });
});

describe('principal and reversibility on the wire', () => {
  it('round-trips the delegation chain and the reversibility class through the schemas', () => {
    const proposal = buildProposal({
      scope: 'listing:1',
      operations: [
        { id: 'c1', op: 'create', collection: 'messages', ref: 'm', value: 'Hello', reversibility: 'irreversible' },
      ],
      provenance: {
        model: 'm',
        principal: { kind: 'agent', id: 'ai:guest-reply', onBehalfOf: 'user-7', authorizationId: 'grant-3' },
      },
    });
    const parsed = proposalSchema.parse(proposal);
    expect(parsed.provenance?.principal).toEqual({ kind: 'agent', id: 'ai:guest-reply', onBehalfOf: 'user-7', authorizationId: 'grant-3' });
    expect(parsed.operations[0]?.reversibility).toBe('irreversible');
    expect(() => proposalSchema.parse({ ...proposal, provenance: { principal: { kind: 'robot', id: 'x' } } })).toThrow();
    expect(() => proposalSchema.parse({ ...proposal, operations: [{ ...proposal.operations[0], reversibility: 'maybe' }] })).toThrow();
  });
});
