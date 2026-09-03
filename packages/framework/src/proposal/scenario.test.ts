/**
 * The contract against real workloads rather than synthetic ones.
 *
 * Each block below replays the *output shape* of a production multi-step AI
 * workflow, taken from a survey of fourteen of them. They were chosen because
 * they disagree with each other: field updates across a locale axis, flat
 * lists of new rows, a tree whose parents do not exist yet, an ordered
 * collection, and a multi-entity fill with partial failure.
 *
 * The first version of this contract expressed only the first shape, which was
 * a workflow it had been designed against, and broke on the other four. That
 * is the failure this file exists to catch: a contract derived from one
 * consumer, shipped as if it were general.
 *
 * These are consumer-shaped fixtures on purpose. The neutral ones live in
 * `proposal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProposal,
  createIdFactory,
  danglingAfterDecision,
  entityAnchor,
  operationsForVariant,
  orderOperations,
  pendingAnchor,
  proposalVariants,
  proposeCreate,
  proposeCreates,
  proposeFields,
  resolveDecision,
  summarize,
  validateProposal,
} from './build';
import { proposalSchema } from './schema';
import { SKIP_REASONS } from './types';
import type { JsonValue, ProposedOperation, SkippedItem } from './types';

const doc = (text: string): JsonValue => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

// ============================================================================
// 1. Field generation across a locale axis
//    Shape: updates on one entity, second axis, mixed rich text and strings.
// ============================================================================

describe('field generation across locales', () => {
  const listing = entityAnchor('listing', 88);
  const nextId = createIdFactory('field');

  const stored = {
    title: { de: 'Ferienwohnung Seeblick 3', en: null },
    excerpt: { de: null, en: null },
    description: { de: doc('Zwei Zimmer am See.'), en: null },
  };

  const generated = {
    de: {
      title: 'Seeblick 3 — Balkon über dem Kochelsee',
      excerpt: 'Zwei Zimmer, Südbalkon.',
      description: doc('Zwei Zimmer am See.'), // the run reproduced what is stored
    },
    en: {
      title: 'Seeblick 3 — Balcony above Lake Kochel',
      excerpt: 'Two rooms, south-facing balcony.',
      description: doc('Two rooms by the lake.'),
    },
  };

  const proposal = buildProposal({
    scope: 'listing:88',
    workflowType: 'listing-field-generation',
    operations: Object.entries(generated).flatMap(([locale, fields]) =>
      proposeFields({
        target: listing,
        variant: locale,
        nextId,
        current: Object.fromEntries(
          Object.keys(fields).map((f) => [f, (stored[f as keyof typeof stored]?.[locale as 'de' | 'en'] ?? null) as JsonValue]),
        ),
        proposed: fields as Record<string, JsonValue>,
        display: {
          title: { labelKey: 'listings.fields.title', control: 'text', maxLength: 255, order: 1 },
          excerpt: { labelKey: 'ai.fields.excerpt', control: 'multiline', maxLength: 500, order: 2 },
          description: { labelKey: 'ai.fields.description', control: 'richtext', order: 3 },
        },
      }),
    ),
    provenance: { model: 'claude-sonnet-4-6', costMicros: 18_420, keySource: 'tenant' },
  });

  it('is structurally valid and wire-safe', () => {
    expect(validateProposal(proposal)).toEqual([]);
    expect(proposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('drops the field the run reproduced unchanged', () => {
    const de = operationsForVariant(proposal, 'de');
    expect(de.map((o) => (o.op === 'update' ? o.path[0] : o.id))).toEqual(['title', 'excerpt']);
  });

  it('separates a rewrite from a fill within one locale', () => {
    const de = operationsForVariant(proposal, 'de');
    const title = de.find((o) => o.op === 'update' && o.path[0] === 'title');
    expect(title?.op === 'update' && title.current).toBe('Ferienwohnung Seeblick 3');
    const excerpt = de.find((o) => o.op === 'update' && o.path[0] === 'excerpt');
    expect(excerpt?.op === 'update' && excerpt.current).toBeNull();
  });

  it('keeps rich text as a document rather than flattening to markup', () => {
    const en = operationsForVariant(proposal, 'en');
    const description = en.find((o) => o.op === 'update' && o.path[0] === 'description');
    expect(description?.op === 'update' && description.proposed).toMatchObject({ type: 'doc' });
  });

  it('accepts one locale of a field without the other', () => {
    const de = operationsForVariant(proposal, 'de');
    const titleDe = de.find((o) => o.op === 'update' && o.path[0] === 'title');
    const resolved = resolveDecision(proposal, { accepted: [titleDe?.id ?? ''] });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.op === 'update' && resolved[0].variant).toBe('de');
  });

  it('exposes the locales as variants', () => {
    expect(proposalVariants(proposal)).toEqual(['de', 'en']);
  });
});

// ============================================================================
// 2. A flat list of new rows
//    Shape: `z.array(z.object(...))` with no ids — canned responses, catalogue
//    bootstrap, referrer options. The first contract could not express this.
// ============================================================================

describe('generating a list of new rows', () => {
  const proposal = buildProposal({
    scope: 'tenant:acme',
    workflowType: 'canned-responses-generation',
    operations: proposeCreates({
      collection: 'cannedResponse',
      items: [
        { ref: 'cr-1', value: { title: 'Late check-in', body: 'Check-in after 22:00 is possible…' } },
        { ref: 'cr-2', value: { title: 'Pets', body: 'One dog is welcome…' } },
        { ref: 'cr-3', value: { title: 'Parking', body: 'One space is included…' } },
      ],
    }),
  });

  it('is valid and carries one create per row', () => {
    expect(validateProposal(proposal)).toEqual([]);
    expect(summarize(proposal)).toMatchObject({ create: 3, update: 0 });
  });

  it('lets a reviewer keep two of three', () => {
    const resolved = resolveDecision(proposal, { accepted: ['create-cr-1', 'create-cr-3'] });
    expect(resolved.map((o) => o.op === 'create' && o.ref)).toEqual(['cr-1', 'cr-3']);
  });

  it('lets a reviewer edit a row before accepting it', () => {
    const resolved = resolveDecision(proposal, {
      accepted: ['create-cr-2'],
      edits: [{ id: 'create-cr-2', value: { title: 'Pets', body: 'Two dogs are welcome…' } }],
    });

    expect(resolved[0]?.edited).toBe(true);
  });
});

// ============================================================================
// 3. A tree whose parents do not exist yet
//    Shape: tempId / parentTempId / existingPlaceId — place hierarchy.
// ============================================================================

describe('proposing a place hierarchy', () => {
  const proposal = buildProposal({
    scope: 'tenant:acme',
    workflowType: 'place-hierarchy',
    operations: [
      // Emitted child-first on purpose: a producer walking its own output has
      // no reason to hand them over in dependency order.
      proposeCreate({
        collection: 'place',
        ref: 'city-meersburg',
        value: { name: 'Meersburg', type: 'city' },
        parent: pendingAnchor('region-bw'),
        derivedFrom: { refs: ['obs-3', 'obs-7'] },
        group: 'city',
      }),
      proposeCreate({
        collection: 'place',
        ref: 'region-bw',
        value: { name: 'Baden-Württemberg', type: 'region' },
        parent: pendingAnchor('country-de'),
        group: 'region',
      }),
      proposeCreate({
        collection: 'place',
        ref: 'country-de',
        value: { name: 'Deutschland', type: 'country' },
        // The tenant already stores this country — a link, not an insert.
        existing: { type: 'place', id: '12' },
        group: 'country',
      }),
    ],
  });

  it('is structurally valid — every parent ref resolves', () => {
    expect(validateProposal(proposal)).toEqual([]);
  });

  it('orders parents before children regardless of emit order', () => {
    const ordered = orderOperations(proposal.operations).map((o) => o.op === 'create' && o.ref);
    expect(ordered).toEqual(['country-de', 'region-bw', 'city-meersburg']);
  });

  it('marks the node that is really a link to an existing place', () => {
    const country = proposal.operations.find((o) => o.op === 'create' && o.ref === 'country-de');
    expect(country?.op === 'create' && country.existing).toEqual({ type: 'place', id: '12' });
  });

  it('carries which observed locations produced a node', () => {
    const city = proposal.operations.find((o) => o.op === 'create' && o.ref === 'city-meersburg');
    expect(city?.derivedFrom?.refs).toEqual(['obs-3', 'obs-7']);
  });

  it('flags a child kept while its parent was rejected', () => {
    const dangling = danglingAfterDecision(proposal, {
      accepted: ['create-city-meersburg', 'create-country-de'],
    });

    expect(dangling.map((o) => o.op === 'create' && o.ref)).toEqual(['city-meersburg']);
  });

  it('reports nothing dangling when the whole branch is accepted', () => {
    const all = proposal.operations.map((o) => o.id);
    expect(danglingAfterDecision(proposal, { accepted: all })).toEqual([]);
  });
});

// ============================================================================
// 4. An ordered collection
//    Shape: `blocks: z.array(...)` where sequence is the meaning — page content.
// ============================================================================

describe('generating page sections', () => {
  const page = entityAnchor('page', 4);

  const proposal = buildProposal({
    scope: 'page:4',
    workflowType: 'page-content-creation',
    operations: [
      ...proposeCreates({
        collection: 'pageBlock',
        items: [
          { ref: 'blk-hero', value: { sectionType: 'hero', config: { headline: 'Am Kochelsee' } } },
          { ref: 'blk-features', value: { sectionType: 'features', config: { items: [] } } },
        ],
      }),
      {
        id: 'order-blocks',
        op: 'reorder',
        collection: 'pageBlock',
        parent: page,
        // An existing intro block keeps its place; the two new ones slot after.
        current: ['blk-intro'],
        proposed: ['blk-intro', 'blk-hero', 'blk-features'],
      },
    ],
  });

  it('is valid and wire-safe', () => {
    expect(validateProposal(proposal)).toEqual([]);
    expect(proposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('places the reorder after the creates of the members it names', () => {
    const ordered = orderOperations(proposal.operations).map((o) => o.id);
    expect(ordered[ordered.length - 1]).toBe('order-blocks');
  });

  it('positions new members among existing ones', () => {
    const reorder = proposal.operations.find((o) => o.op === 'reorder');
    expect(reorder?.op === 'reorder' && reorder.proposed).toEqual(['blk-intro', 'blk-hero', 'blk-features']);
  });
});

// ============================================================================
// 5. A multi-entity fill with partial failure
//    Shape: entityType/entityId per unit, deep leaf paths, a source that is not
//    `current`, and a typed skip channel — translation fill.
// ============================================================================

describe('filling translations across many entities', () => {
  const nextId = createIdFactory('fill');

  const operations: ProposedOperation[] = [
    ...proposeFields({
      target: entityAnchor('listing', 88, 'Seeblick 3'),
      variant: 'en',
      nextId,
      current: { title: null },
      proposed: { title: 'Balcony above Lake Kochel' },
      derivedFrom: { title: { label: 'de', preview: 'Balkon über dem Kochelsee' } },
      guard: { title: 'sha256:9f2c' },
      group: 'listing',
    }),
    ...proposeFields({
      target: entityAnchor('amenity', 12, 'Sauna'),
      variant: 'en',
      nextId,
      current: { label: null },
      proposed: { label: 'Sauna' },
      derivedFrom: { label: { label: 'de', preview: 'Sauna' } },
      group: 'amenity',
    }),
  ];

  // A leaf inside a structured page section — the case a flat field name
  // cannot address.
  const deepLeaf: ProposedOperation = {
    id: 'fill-deep',
    op: 'update',
    target: entityAnchor('pageBlock', 'blk-7'),
    path: ['config', 'features', 2, 'caption'],
    variant: 'en',
    current: null,
    proposed: 'Four minutes from the shore',
    derivedFrom: { label: 'de', preview: 'Vier Gehminuten zum Seeufer' },
    group: 'page',
  };

  const skipped: SkippedItem[] = [
    {
      target: entityAnchor('listing', 91),
      path: ['title'],
      variant: 'en',
      reason: SKIP_REASONS.sourceChanged,
      detail: 'German source edited after the run started.',
    },
    { target: entityAnchor('amenity', 30), path: ['label'], variant: 'en', reason: SKIP_REASONS.alreadyFilled },
  ];

  const proposal = buildProposal({
    scope: 'tenant:acme',
    workflowType: 'translation-fill',
    operations: [...operations, deepLeaf],
    skipped,
  });

  it('is valid and wire-safe across many entities', () => {
    expect(validateProposal(proposal)).toEqual([]);
    expect(proposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('targets three different entities from one proposal', () => {
    const targets = proposal.operations.map((o) => (o.op === 'update' ? `${o.target.kind === 'entity' ? o.target.type : ''}` : ''));
    expect(new Set(targets)).toEqual(new Set(['listing', 'amenity', 'pageBlock']));
  });

  it('shows the source it was translated from, since there is nothing it replaces', () => {
    const listing = proposal.operations.find((o) => o.group === 'listing');
    expect(listing?.op === 'update' && listing.current).toBeNull();
    expect(listing?.derivedFrom).toMatchObject({ label: 'de', preview: 'Balkon über dem Kochelsee' });
  });

  it('addresses a leaf inside a structured document', () => {
    const deep = proposal.operations.find((o) => o.id === 'fill-deep');
    expect(deep?.op === 'update' && deep.path).toEqual(['config', 'features', 2, 'caption']);
  });

  it('carries a drift guard for re-checking at apply time', () => {
    const listing = proposal.operations.find((o) => o.group === 'listing');
    expect(listing?.op === 'update' && listing.guard).toBe('sha256:9f2c');
  });

  it('reports what it considered and did not propose, with reasons', () => {
    expect(proposal.skipped).toHaveLength(2);
    expect(proposal.skipped?.map((s) => s.reason)).toEqual(['source_changed', 'already_filled']);
  });

  it('keeps a unit that failed out of the operations entirely', () => {
    const ids = proposal.operations.map((o) => o.id);
    expect(ids).toHaveLength(3);
    expect(proposal.skipped?.every((s) => !ids.includes(String(s.target?.kind)))).toBe(true);
  });
});
