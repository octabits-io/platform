/**
 * AI workflow routes — what remains app-side after both extraction layers.
 *
 * The generic read/control routes (list, active-probe, get, snapshot, cancel,
 * resume) come from `createFlowWorkflowRoutes` (`…/hono/flow`), which serves
 * flow's public wire view — the schemas, the record→API projection, and the
 * step-status fold that used to be ~100 hand-written lines in this file live
 * upstream (flow owns the shapes, the framework owns the serving conventions).
 * The kit's `AiWorkflowData` contract is that view plus `appliedAt`, added
 * through the `extendWorkflow` seam so the declared schema and the served
 * value cannot drift.
 *
 * The Hono factory drops the Elysia version's `prefix`/`tags` options: it
 * returns a plain sub-app the caller mounts with `app.route('/workflows', …)`,
 * so *where* it lives is the caller's call, not an option.
 *
 * What stays here is genuinely this app's:
 * - the trigger route — `contactId` body vocabulary, the `contact:<id>`
 *   entityRef convention, and the workflow-type dispatch table;
 * - the `ai_quota_exceeded → 429` mapping (no framework key convention);
 * - `/usage` — the quota/usage read over `octaflow/ai`'s aggregation
 *   service (an AI-layer concern, not a core engine projection);
 * - `/workflows/:id/apply` and `/revert` — the host's half of the review loop
 *   (`ai/proposals.ts`): a reviewer's `ProposalDecision` in, the rows a
 *   proposal names written, an audit row kept, and `appliedAt` projected from
 *   that row through the `extendWorkflow` seam.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponses, successResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { createFlowWorkflowRoutes, SCHEMA_ID_PARAM } from '@octabits-io/framework/hono/flow';
import { proposalDecisionSchema } from '@octabits-io/framework/proposal';
import type { AiUsageAggregationService } from 'octaflow/ai';
import { createErrorJson } from '../http.ts';
import type { DemoAiEngine } from '../ai/engine.ts';
import type { ProposalService } from '../ai/proposals.ts';
import { aiWorkflowsByType, CONTACT_BRIEF_TYPE } from '../ai/workflows.ts';

/**
 * Domain keys → status. The `proposal_*` keys are this app's (see
 * `ai/proposals.ts`). Only `*_not_found` maps by framework convention; the
 * conflict keys are prefixed with the domain, so they are listed here.
 */
const AI_ERROR_OVERRIDES = {
  ai_quota_exceeded: 429,
  proposal_drift: 409,
  proposal_already_applied: 409,
  proposal_already_reverted: 409,
  proposal_not_applied: 409,
  proposal_invalid: 400,
  proposal_unsupported_operation: 400,
};
const errorJson = createErrorJson(AI_ERROR_OVERRIDES);

const isoDate = (d: Date): string => d.toISOString().split('T')[0]!;

const SCHEMA_USAGE_ROW = z.object({
  date: z.string(),
  workflowCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  estimatedCostMicros: z.number().int(),
});

const TAGS = ['AI'];

export interface AiRoutesDeps {
  engine: DemoAiEngine;
  usage: AiUsageAggregationService;
  partitionKey: string;
  proposals: ProposalService;
}

export function createAiRoutes({ engine, usage, partitionKey, proposals }: AiRoutesDeps) {
  return new Hono()
    .post(
      '/workflows',
      describeApiRoute({
        summary: 'Start an AI workflow for a contact',
        tags: TAGS,
        responses: {
          ...successResponses(202, z.object({ workflowId: z.number().int(), totalSteps: z.number().int() })),
          ...errorResponses(400, 404, 429, 500),
        },
      }),
      octApiValidator('json', z.object({ type: z.literal(CONTACT_BRIEF_TYPE), contactId: z.uuid() })),
      async (c) => {
        const body = c.req.valid('json');
        const workflow = aiWorkflowsByType[body.type];
        if (!workflow) {
          return errorJson(c, {
            key: 'workflow_type_not_found',
            message: `Unknown workflow type '${body.type}'`,
          });
        }
        const started = await workflow.start(
          engine,
          { contactId: body.contactId },
          { entityRef: `contact:${body.contactId}` },
        );
        if (!started.ok) return errorJson(c, started.error);
        return c.json({ workflowId: started.value.workflowId, totalSteps: started.value.totalSteps }, 202);
      },
    )
    .get(
      '/usage',
      describeApiRoute({
        summary: 'AI usage rollup (last 30 days) and current quota usage',
        tags: TAGS,
        responses: {
          200: z.object({
            byDate: z.array(SCHEMA_USAGE_ROW),
            current: z.object({
              today: z.object({ workflowCount: z.number().int() }),
              thisMonth: z.object({ workflowCount: z.number().int() }),
              running: z.object({ count: z.number().int() }),
            }),
          }),
          ...errorResponses(429, 500),
        },
      }),
      async (c) => {
        const end = new Date();
        const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
        const range = { partitionKey, startDate: isoDate(start), endDate: isoDate(end) };
        const [byDate, current] = await Promise.all([
          usage.getUsageSummary(range),
          usage.getCurrentQuotaUsage({ partitionKey }),
        ]);
        if (!byDate.ok) return errorJson(c, byDate.error);
        if (!current.ok) return errorJson(c, current.error);
        return c.json({ byDate: byDate.value, current: current.value });
      },
    )
    .post(
      '/workflows/:id/apply',
      describeApiRoute({
        summary: "Apply a reviewer's decision on a completed workflow's proposal",
        description:
          'Body is the `ProposalDecision` the review card emits: accepted operation ids plus edits. Refuses with 409 `proposal_drift` when the contact changed since the proposal was made, and 409 `proposal_already_applied` while an application stands.',
        tags: TAGS,
        responses: {
          ...successResponses(200, z.object({ appliedAt: z.string(), created: z.record(z.string(), z.string()) })),
          ...errorResponses(400, 404, 409, 429, 500),
        },
      }),
      octApiValidator('param', SCHEMA_ID_PARAM),
      octApiValidator('json', proposalDecisionSchema),
      async (c) => {
        const { id } = c.req.valid('param');
        // The demo's identity is a role header; a real host records the principal.
        const applied = await proposals.apply(id, c.req.valid('json'), c.req.header('x-demo-role') ?? null);
        if (!applied.ok) return errorJson(c, applied.error);
        return c.json(applied.value);
      },
    )
    .post(
      '/workflows/:id/revert',
      describeApiRoute({
        summary: 'Undo an applied proposal',
        description:
          'Derives the inverse operations from the audit row (`invertOperations`) and writes them through the same path apply used. 409 `proposal_not_applied` / `proposal_already_reverted` otherwise.',
        tags: TAGS,
        responses: {
          ...successResponses(200, z.object({ revertedAt: z.string(), missing: z.array(z.string()) })),
          ...errorResponses(400, 404, 409, 429, 500),
        },
      }),
      octApiValidator('param', SCHEMA_ID_PARAM),
      async (c) => {
        const reverted = await proposals.revert(c.req.valid('param').id);
        if (!reverted.ok) return errorJson(c, reverted.error);
        return c.json(reverted.value);
      },
    )
    // Mounted last so `/workflows` (POST, above) is declared before the
    // factory's `/workflows/:id` family — Hono's router resolves either order,
    // but reading order should match route specificity.
    .route(
      '/workflows',
      createFlowWorkflowRoutes({
        engine,
        errorOverrides: AI_ERROR_OVERRIDES,
        extendWorkflow: {
          // `appliedAt` is the kit's vocabulary, not flow's. It is projected
          // from this app's audit row (`proposal_applications`), batched once
          // per request through `load` — never stored on the workflow.
          schema: { appliedAt: z.string().nullable(), revertedAt: z.string().nullable() },
          load: async (workflows) => {
            const rows = await proposals.applications.getMany(workflows.map((w) => w.id));
            return rows.ok ? rows.value : new Map();
          },
          project: (workflow, loaded) => {
            const application = loaded?.get(workflow.id);
            return {
              appliedAt: application && application.revertedAt === null ? application.appliedAt : null,
              revertedAt: application?.revertedAt ?? null,
            };
          },
        },
      }),
    );
}
