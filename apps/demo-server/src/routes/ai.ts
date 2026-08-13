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
 *   service (an AI-layer concern, not a core engine projection).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponses, successResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { createFlowWorkflowRoutes } from '@octabits-io/framework/hono/flow';
import type { AiUsageAggregationService } from 'octaflow/ai';
import { createErrorJson } from '../http.ts';
import type { DemoAiEngine } from '../ai/engine.ts';
import { aiWorkflowsByType, CONTACT_BRIEF_TYPE } from '../ai/workflows.ts';

const AI_ERROR_OVERRIDES = { ai_quota_exceeded: 429 };
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
}

export function createAiRoutes({ engine, usage, partitionKey }: AiRoutesDeps) {
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
    // Mounted last so `/workflows` (POST, above) is declared before the
    // factory's `/workflows/:id` family — Hono's router resolves either order,
    // but reading order should match route specificity.
    .route(
      '/workflows',
      createFlowWorkflowRoutes({
        engine,
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
    );
}
