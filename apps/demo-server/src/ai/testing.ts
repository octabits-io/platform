/**
 * A fully in-memory AI runtime — the no-Docker twin of `runtime.ts`.
 *
 * Same engine factory, same hooks, same scripted model; only the adapters
 * differ: flow's `createInMemoryWorkflowStore` instead of Postgres, an
 * array-backed dispatcher instead of pg-boss (`drain()` plays the worker), and
 * Map-backed usage/quota stores instead of the `ai_*` tables. Tests drive the
 * real HTTP routes against this and cover trigger → execute → poll → usage
 * rollup without a database or network. This is the "very simple model that
 * runs in memory" answer, end to end.
 */
import {
  createInMemoryWorkflowStore,
  type Dispatcher,
  type DispatchStepPayload,
  type WorkflowStore,
} from '@octabits-io/flow';
import {
  createAiQuotaService,
  createAiUsageAggregationService,
  DEFAULT_AI_QUOTA,
  type AiUsageAggregationService,
  type AiUsageStore,
  type AiUsageRecorder,
  type DailyUsageDelta,
} from '@octabits-io/flow/ai';
import type { Logger } from '@octabits-io/framework/logger';
import { createAiEngine, type DemoAiEngine } from './engine.ts';
import type { AiHost } from './workflows.ts';

export interface RecordedStepUsage {
  workflowId: number;
  stepId: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  modelId: string;
}

export interface InMemoryAiRuntime {
  engine: DemoAiEngine;
  usage: AiUsageAggregationService;
  partitionKey: string;
  /** Per-step usage rows the recorder captured (assert token/cost capture). */
  stepUsage: RecordedStepUsage[];
  /** Run queued steps until the queue is empty — the in-process "worker". */
  drain(): Promise<void>;
}

function createInMemoryUsageStore(workflowStore: WorkflowStore): AiUsageStore {
  const daily = new Map<string, DailyUsageDelta>();
  const keyOf = (d: { partitionKey: string; date: string; workflowType: string; keySource: string }) =>
    `${d.partitionKey}|${d.date}|${d.workflowType}|${d.keySource}`;

  return {
    async countRunningWorkflows() {
      const [pending, running] = await Promise.all([
        workflowStore.listWorkflows({ status: 'pending' }),
        workflowStore.listWorkflows({ status: 'running' }),
      ]);
      return pending.length + running.length;
    },
    async sumWorkflowCount({ startDate, endDate }) {
      let sum = 0;
      for (const d of daily.values()) if (d.date >= startDate && d.date <= endDate) sum += d.workflowCount;
      return sum;
    },
    async addDailyUsage(delta) {
      const existing = daily.get(keyOf(delta));
      if (!existing) {
        daily.set(keyOf(delta), { ...delta, usage: { ...delta.usage } });
        return;
      }
      existing.workflowCount += delta.workflowCount;
      existing.usage.inputTokens += delta.usage.inputTokens;
      existing.usage.outputTokens += delta.usage.outputTokens;
      existing.usage.cacheReadTokens += delta.usage.cacheReadTokens;
      existing.usage.cacheWriteTokens += delta.usage.cacheWriteTokens;
      existing.estimatedCostMicros += delta.estimatedCostMicros;
    },
    async aggregateByDate({ startDate, endDate }) {
      const byDate = new Map<string, ReturnType<AiUsageStore['aggregateByDate']> extends Promise<(infer R)[]> ? R : never>();
      for (const d of daily.values()) {
        if (d.date < startDate || d.date > endDate) continue;
        const row = byDate.get(d.date) ?? {
          date: d.date, workflowCount: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostMicros: 0,
        };
        row.workflowCount += d.workflowCount;
        row.inputTokens += d.usage.inputTokens;
        row.outputTokens += d.usage.outputTokens;
        row.cacheReadTokens += d.usage.cacheReadTokens;
        row.cacheWriteTokens += d.usage.cacheWriteTokens;
        row.estimatedCostMicros += d.estimatedCostMicros;
        byDate.set(d.date, row);
      }
      return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    },
    async aggregateByWorkflowType({ startDate, endDate }) {
      const byType = new Map<string, ReturnType<AiUsageStore['aggregateByWorkflowType']> extends Promise<(infer R)[]> ? R : never>();
      for (const d of daily.values()) {
        if (d.date < startDate || d.date > endDate) continue;
        const key = `${d.workflowType}|${d.keySource}`;
        const row = byType.get(key) ?? {
          workflowType: d.workflowType, keySource: d.keySource,
          workflowCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0,
        };
        row.workflowCount += d.workflowCount;
        row.inputTokens += d.usage.inputTokens;
        row.outputTokens += d.usage.outputTokens;
        row.estimatedCostMicros += d.estimatedCostMicros;
        byType.set(key, row);
      }
      return [...byType.values()];
    },
  };
}

export interface CreateInMemoryAiRuntimeDeps {
  host: AiHost;
  logger: Logger;
  partitionKey?: string;
}

export function createInMemoryAiRuntime(deps: CreateInMemoryAiRuntimeDeps): InMemoryAiRuntime {
  const partitionKey = deps.partitionKey ?? 'demo-test';
  const store = createInMemoryWorkflowStore(partitionKey);

  const usageStore = createInMemoryUsageStore(store);
  const usage = createAiUsageAggregationService({ store: usageStore, logger: deps.logger });
  const quota = createAiQuotaService({ store: usageStore, getQuota: () => DEFAULT_AI_QUOTA });

  const queue: DispatchStepPayload[] = [];
  const dispatcher: Dispatcher = {
    async enqueueStep(payload) {
      queue.push(payload);
      return { ok: true, value: undefined };
    },
  };

  const stepUsage: RecordedStepUsage[] = [];
  const totals = new Map<
    number,
    { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number }
  >();
  const usageRecorder: AiUsageRecorder = {
    async recordStepUsage({ workflowId, stepId, usage: u, costMicros }) {
      stepUsage.push({
        workflowId, stepId, costMicros,
        inputTokens: u.inputTokens, outputTokens: u.outputTokens, modelId: u.modelId,
      });
    },
    async incrementWorkflowUsage({ workflowId, usage: u, costMicros }) {
      const t = totals.get(workflowId) ?? {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0,
      };
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheWriteTokens += u.cacheWriteTokens;
      t.costMicros += costMicros;
      totals.set(workflowId, t);
    },
    async recordWorkflowDaily({ workflowId, workflowType, keySource, date }) {
      const t = totals.get(workflowId);
      if (!t) return;
      await usage.recordWorkflowCompletion({
        partitionKey, date, workflowType, keySource,
        usage: {
          inputTokens: t.inputTokens, outputTokens: t.outputTokens,
          cacheReadTokens: t.cacheReadTokens, cacheWriteTokens: t.cacheWriteTokens,
        },
        estimatedCostMicros: t.costMicros,
      });
    },
  };

  const engine = createAiEngine({
    store,
    dispatcher,
    partitionKey,
    host: deps.host,
    logger: deps.logger,
    usageRecorder,
    quotaPolicy: { checkQuota: () => quota.checkQuota(partitionKey) },
  });

  return {
    engine,
    usage,
    partitionKey,
    stepUsage,
    async drain() {
      while (queue.length > 0) {
        const job = queue.shift()!;
        await engine.executeStep(job.workflowId, job.stepId);
      }
    },
  };
}
