/**
 * Zod schemas for the proposal contract.
 *
 * A proposal crosses the wire twice — server to review surface, decision back
 * — and is persisted in between, so both directions get validated rather than
 * cast. `proposalDecisionSchema` in particular guards a client-supplied
 * payload: see the note on `ProposalDecision.edits`.
 *
 * These validate *shape*. Structural coherence — unique refs, every pending
 * anchor resolved, no cycles — is `validateProposal` in `./build`, because it
 * is a property of the whole document rather than of any one field.
 */
import { z } from 'zod';
import type { JsonValue } from './types';

/** Recursive JSON value. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const pathSegmentSchema = z.union([z.string().min(1), z.number().int()]);
export const pathSchema = z.array(pathSegmentSchema).min(1);

export const entityRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  label: z.string().optional(),
});

export const anchorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entity'),
    type: z.string().min(1),
    id: z.string().min(1),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('pending'),
    ref: z.string().min(1),
    label: z.string().optional(),
  }),
]);

export const changeDisplaySchema = z.object({
  label: z.string().optional(),
  labelKey: z.string().optional(),
  control: z
    .enum(['text', 'multiline', 'richtext', 'number', 'boolean', 'list', 'image', 'json'])
    .optional(),
  maxLength: z.number().int().positive().optional(),
  hint: z
    .object({
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().optional(),
    })
    .optional(),
  order: z.number().optional(),
});

export const derivationSchema = z.object({
  label: z.string().optional(),
  preview: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

export const principalSchema = z.object({
  kind: z.enum(['agent', 'user', 'system']),
  id: z.string().min(1),
  label: z.string().optional(),
  onBehalfOf: z.string().min(1).optional(),
  authorizationId: z.string().min(1).optional(),
});

export const reversibilitySchema = z.enum(['reversible', 'compensable', 'irreversible']);

const operationBase = {
  id: z.string().min(1),
  group: z.string().optional(),
  display: changeDisplaySchema.optional(),
  derivedFrom: derivationSchema.optional(),
  reversibility: reversibilitySchema.optional(),
};

export const updateOperationSchema = z.object({
  ...operationBase,
  op: z.literal('update'),
  target: anchorSchema,
  path: pathSchema,
  variant: z.string().min(1).optional(),
  // Required, not optional — an operation that cannot say what it replaces is
  // not reviewable. `null` is the encoding for "the slot was empty".
  current: jsonValueSchema,
  proposed: jsonValueSchema,
  guard: z.string().optional(),
});

export const createOperationSchema = z.object({
  ...operationBase,
  op: z.literal('create'),
  collection: z.string().min(1),
  ref: z.string().min(1),
  parent: anchorSchema.optional(),
  value: jsonValueSchema,
  existing: entityRefSchema.optional(),
});

export const deleteOperationSchema = z.object({
  ...operationBase,
  op: z.literal('delete'),
  target: anchorSchema,
  current: jsonValueSchema,
});

export const reorderOperationSchema = z.object({
  ...operationBase,
  op: z.literal('reorder'),
  collection: z.string().min(1),
  parent: anchorSchema.optional(),
  current: z.array(z.string()),
  proposed: z.array(z.string()),
});

export const proposedOperationSchema = z.discriminatedUnion('op', [
  updateOperationSchema,
  createOperationSchema,
  deleteOperationSchema,
  reorderOperationSchema,
]);

export const skippedItemSchema = z.object({
  target: anchorSchema.optional(),
  path: pathSchema.optional(),
  variant: z.string().min(1).optional(),
  reason: z.string().min(1),
  detail: z.string().optional(),
});

export const proposalProvenanceSchema = z.object({
  model: z.string().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  keySource: z.string().optional(),
  generatedAt: z.string().optional(),
  principal: principalSchema.optional(),
});

export const proposalApplicationSchema = z.object({
  at: z.string(),
  by: z.string(),
  principal: principalSchema.optional(),
  accepted: z.array(z.string().min(1)),
});

export const proposalSchema = z.object({
  scope: z.string().min(1),
  workflowId: z.union([z.number(), z.string()]).optional(),
  workflowType: z.string().optional(),
  operations: z.array(proposedOperationSchema),
  skipped: z.array(skippedItemSchema).optional(),
  provenance: proposalProvenanceSchema.optional(),
  applied: proposalApplicationSchema.nullable().optional(),
});

export const proposalDecisionSchema = z.object({
  accepted: z.array(z.string().min(1)),
  edits: z.array(z.object({ id: z.string().min(1), value: jsonValueSchema })).optional(),
});

export type ProposalSchemaOutput = z.infer<typeof proposalSchema>;
export type ProposalDecisionSchemaOutput = z.infer<typeof proposalDecisionSchema>;
