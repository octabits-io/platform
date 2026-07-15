/**
 * AI workflow routes — what remains app-side after both extraction layers.
 *
 * The generic read/control routes (list, active-probe, get, snapshot, cancel,
 * resume) come from `createFlowWorkflowRoutes` (`…/elysia/flow`), which serves
 * flow's public wire view — the schemas, the record→API projection, and the
 * step-status fold that used to be ~100 hand-written lines in this file now
 * live upstream (flow owns the shapes, the framework owns the serving
 * conventions). The kit's `AiWorkflowData` contract is that view plus
 * `appliedAt`, added through the `extendWorkflow` seam so the declared schema
 * and the served value cannot drift.
 *
 * What stays here is genuinely this app's:
 * - the trigger route — `contactId` body vocabulary, the `contact:<id>`
 *   entityRef convention, and the workflow-type dispatch table;
 * - the `ai_quota_exceeded → 429` mapping (no framework key convention);
 * - `/usage` — the quota/usage read over `@octabits-io/flow/ai`'s aggregation
 *   service (an AI-layer concern, not a core engine projection).
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { createErrorMapper, errorResponses, successResponses } from '@octabits-io/framework/elysia';
import { createFlowWorkflowRoutes } from '@octabits-io/framework/elysia/flow';
import type { AiUsageAggregationService } from '@octabits-io/flow/ai';
import type { DemoAiEngine } from '../ai/engine.ts';
import { aiWorkflowsByType, CONTACT_BRIEF_TYPE } from '../ai/workflows.ts';

const AI_ERROR_OVERRIDES = { ai_quota_exceeded: 429 };
const { statusErrorWithSet } = createErrorMapper(AI_ERROR_OVERRIDES);

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

export interface AiRoutesDeps {
  engine: DemoAiEngine;
  usage: AiUsageAggregationService;
  partitionKey: string;
}

export function createAiRoutes({ engine, usage, partitionKey }: AiRoutesDeps) {
  return new Elysia({ prefix: '/ai', tags: ['AI'] })
    .post(
      '/workflows',
      async ({ body, set }) => {
        const workflow = aiWorkflowsByType[body.type];
        if (!workflow) {
          return statusErrorWithSet(set, { key: 'workflow_type_not_found', message: `Unknown workflow type '${body.type}'` });
        }
        const started = await workflow.start(
          engine,
          { contactId: body.contactId },
          { entityRef: `contact:${body.contactId}` },
        );
        if (!started.ok) return statusErrorWithSet(set, started.error);
        set.status = 202;
        return { workflowId: started.value.workflowId, totalSteps: started.value.totalSteps };
      },
      {
        body: z.object({
          type: z.literal(CONTACT_BRIEF_TYPE),
          contactId: z.uuid(),
        }),
        response: {
          ...successResponses(202, z.object({ workflowId: z.number().int(), totalSteps: z.number().int() })),
          ...errorResponses(400, 404, 429, 500),
        },
        detail: { summary: 'Start an AI workflow for a contact' },
      },
    )
    .use(
      createFlowWorkflowRoutes({
        engine,
        tags: ['AI'],
        errorOverrides: AI_ERROR_OVERRIDES,
        extendWorkflow: {
          // `appliedAt` is the kit's vocabulary, not flow's — no apply flow on
          // the server; the SPA applies results as domain writes (create a
          // note) and tracks applied state client-side.
          schema: { appliedAt: z.string().nullable() },
          project: (workflow) => ({
            appliedAt: (workflow.metadata?.appliedAt as string | undefined) ?? null,
          }),
        },
      }),
    )
    .get(
      '/usage',
      async ({ set }) => {
        const end = new Date();
        const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
        const range = { partitionKey, startDate: isoDate(start), endDate: isoDate(end) };
        const [byDate, current] = await Promise.all([
          usage.getUsageSummary(range),
          usage.getCurrentQuotaUsage({ partitionKey }),
        ]);
        if (!byDate.ok) return statusErrorWithSet(set, byDate.error);
        if (!current.ok) return statusErrorWithSet(set, current.error);
        return { byDate: byDate.value, current: current.value };
      },
      {
        response: {
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
        detail: { summary: 'AI usage rollup (last 30 days) and current quota usage' },
      },
    );
}
