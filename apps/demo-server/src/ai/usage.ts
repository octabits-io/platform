/**
 * The consumer side of flow's AI usage/quota seams.
 *
 * flow deliberately ships no SQL for usage metering: `AiQuotaStore` /
 * `AiUsageStore` are structural interfaces the consumer implements against its
 * own tables (`…/ai/quota.ts`, `…/ai/usage-aggregation.ts` own the window math
 * and enforcement order above the seam). This file is that implementation —
 * raw `pg` over the three `ai_*` tables from `db/ddl.ts`, since the flow-owned
 * `flow_workflow` table it also counts from is not part of the app's Drizzle
 * schema.
 *
 * Also here: the `AiUsageRecorder` the AI hooks call around each step —
 * per-step rows into `ai_step_usage`, running workflow totals UPSERTed into
 * `ai_workflow_usage`, and on completion a daily rollup delegated to the
 * aggregation service (which UPSERTs `ai_usage_daily` through the store).
 */
import type { Pool } from 'pg';
import type {
  AiUsageStore,
  AiUsageRecorder,
  AiUsageAggregationService,
  DailyUsageDelta,
  AiUsageRangeQuery,
  UsageSummaryRow,
  UsageByTypeRow,
  AiUsageCountQuery,
} from '@octabits-io/flow/ai';
import type { Logger } from '@octabits-io/framework/logger';

export function createAiUsageStore(pool: Pool): AiUsageStore {
  return {
    async countRunningWorkflows(partitionKey: string): Promise<number> {
      // 'pending' counts too: a created-but-not-yet-running workflow already
      // occupies a concurrency slot from the caller's point of view.
      const res = await pool.query(
        `SELECT count(*)::int AS count FROM flow_workflow
         WHERE partition_key = $1 AND status IN ('pending', 'running')`,
        [partitionKey],
      );
      return res.rows[0]?.count ?? 0;
    },

    async sumWorkflowCount(query: AiUsageCountQuery): Promise<number> {
      const res = await pool.query(
        `SELECT coalesce(sum(workflow_count), 0)::int AS count FROM ai_usage_daily
         WHERE partition_key = $1 AND usage_date BETWEEN $2 AND $3`,
        [query.partitionKey, query.startDate, query.endDate],
      );
      return res.rows[0]?.count ?? 0;
    },

    async addDailyUsage(delta: DailyUsageDelta): Promise<void> {
      await pool.query(
        `INSERT INTO ai_usage_daily (
           partition_key, usage_date, workflow_type, key_source, workflow_count,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_micros
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (partition_key, usage_date, workflow_type, key_source) DO UPDATE SET
           workflow_count = ai_usage_daily.workflow_count + excluded.workflow_count,
           input_tokens = ai_usage_daily.input_tokens + excluded.input_tokens,
           output_tokens = ai_usage_daily.output_tokens + excluded.output_tokens,
           cache_read_tokens = ai_usage_daily.cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = ai_usage_daily.cache_write_tokens + excluded.cache_write_tokens,
           estimated_cost_micros = ai_usage_daily.estimated_cost_micros + excluded.estimated_cost_micros`,
        [
          delta.partitionKey,
          delta.date,
          delta.workflowType,
          delta.keySource,
          delta.workflowCount,
          delta.usage.inputTokens,
          delta.usage.outputTokens,
          delta.usage.cacheReadTokens,
          delta.usage.cacheWriteTokens,
          delta.estimatedCostMicros,
        ],
      );
    },

    async aggregateByDate(query: AiUsageRangeQuery): Promise<UsageSummaryRow[]> {
      const res = await pool.query(
        `SELECT to_char(usage_date, 'YYYY-MM-DD') AS date,
                sum(workflow_count)::int AS "workflowCount",
                sum(input_tokens)::int AS "inputTokens",
                sum(output_tokens)::int AS "outputTokens",
                sum(cache_read_tokens)::int AS "cacheReadTokens",
                sum(cache_write_tokens)::int AS "cacheWriteTokens",
                sum(estimated_cost_micros)::int AS "estimatedCostMicros"
         FROM ai_usage_daily
         WHERE partition_key = $1 AND usage_date BETWEEN $2 AND $3
         GROUP BY usage_date ORDER BY usage_date`,
        [query.partitionKey, query.startDate, query.endDate],
      );
      return res.rows;
    },

    async aggregateByWorkflowType(query: AiUsageRangeQuery): Promise<UsageByTypeRow[]> {
      const res = await pool.query(
        `SELECT workflow_type AS "workflowType",
                key_source AS "keySource",
                sum(workflow_count)::int AS "workflowCount",
                sum(input_tokens)::int AS "inputTokens",
                sum(output_tokens)::int AS "outputTokens",
                sum(estimated_cost_micros)::int AS "estimatedCostMicros"
         FROM ai_usage_daily
         WHERE partition_key = $1 AND usage_date BETWEEN $2 AND $3
         GROUP BY workflow_type, key_source ORDER BY workflow_type, key_source`,
        [query.partitionKey, query.startDate, query.endDate],
      );
      return res.rows;
    },
  };
}

export interface CreateAiUsageRecorderDeps {
  pool: Pool;
  /** Rolls completed-workflow totals into `ai_usage_daily` (via the store's UPSERT). */
  aggregation: AiUsageAggregationService;
  partitionKey: string;
  logger: Logger;
}

/** The hooks-side recorder: step rows, workflow running totals, daily rollup. */
export function createAiUsageRecorder(deps: CreateAiUsageRecorderDeps): AiUsageRecorder {
  const { pool, aggregation, partitionKey, logger } = deps;

  return {
    async recordStepUsage({ stepId, workflowId, usage, costMicros }) {
      await pool.query(
        `INSERT INTO ai_step_usage (
           step_id, workflow_id, model_id, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_micros
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (step_id) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           cost_micros = excluded.cost_micros`,
        [
          stepId,
          workflowId,
          usage.modelId,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          costMicros,
        ],
      );
    },

    async incrementWorkflowUsage({ workflowId, usage, costMicros }) {
      await pool.query(
        `INSERT INTO ai_workflow_usage (
           workflow_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workflow_id) DO UPDATE SET
           input_tokens = ai_workflow_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_workflow_usage.output_tokens + excluded.output_tokens,
           cache_read_tokens = ai_workflow_usage.cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = ai_workflow_usage.cache_write_tokens + excluded.cache_write_tokens,
           cost_micros = ai_workflow_usage.cost_micros + excluded.cost_micros,
           updated_at = now()`,
        [workflowId, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, costMicros],
      );
    },

    async recordWorkflowDaily({ workflowId, workflowType, keySource, date }) {
      const res = await pool.query(
        `SELECT input_tokens::int AS "inputTokens", output_tokens::int AS "outputTokens",
                cache_read_tokens::int AS "cacheReadTokens", cache_write_tokens::int AS "cacheWriteTokens",
                cost_micros::int AS "costMicros"
         FROM ai_workflow_usage WHERE workflow_id = $1`,
        [workflowId],
      );
      const totals = res.rows[0];
      if (!totals) return; // No model call ever ran (e.g. every AI step failed) — nothing to roll up.

      const rolled = await aggregation.recordWorkflowCompletion({
        partitionKey,
        date,
        workflowType,
        keySource,
        usage: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
        },
        estimatedCostMicros: totals.costMicros,
      });
      // The engine fires this hook fire-and-forget; a failed rollup must be
      // visible somewhere, and that somewhere is the log.
      if (!rolled.ok)
        logger.error('AI daily usage rollup failed', undefined, { workflowId, message: rolled.error.message });
    },
  };
}
