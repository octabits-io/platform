/**
 * Production wiring for the AI workflow engine — Postgres + pg-boss.
 *
 * This is example 12/13 from the flow repo translated into this app's shapes:
 * `createPgWorkflowStore` over the app's existing `pg` Pool (the DDL already
 * ran in `ensureSchema`), `createPgBossDispatcher` + step/DLQ workers over the
 * SAME pg-boss instance `BossManager` owns (flow never creates its own boss —
 * `boss.getBoss()` is the seam), and the quota/usage services from
 * `@octabits-io/flow/ai` over the consumer-SQL store in `usage.ts`.
 *
 * Single-scope app ⇒ one constant partition key and one engine for the whole
 * process. A multi-tenant host would build store/dispatcher/engine per
 * partition key instead (they are cheap, stateless factories over shared
 * pool + boss).
 */
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { createPgWorkflowStore } from '@octabits-io/flow/store-pg';
import {
  createPgBossDispatcher,
  createPgBossStepWorker,
  createPgBossDlqWorker,
} from '@octabits-io/flow/dispatcher-pgboss';
import {
  createAiQuotaService,
  createAiUsageAggregationService,
  DEFAULT_AI_QUOTA,
  type AiUsageAggregationService,
} from '@octabits-io/flow/ai';
import type { Logger } from '@octabits-io/framework/logger';
import { createAiEngine, type DemoAiEngine } from './engine.ts';
import { createAiUsageStore, createAiUsageRecorder } from './usage.ts';
import type { AiHost } from './workflows.ts';

/** Single-scope demo: every workflow lives under one partition. */
export const AI_PARTITION_KEY = 'demo';

const AI_STEP_QUEUE = 'flow-steps';

export interface CreateAiRuntimeDeps {
  pool: Pool;
  boss: PgBoss;
  host: AiHost;
  logger: Logger;
}

export interface AiRuntime {
  engine: DemoAiEngine;
  usage: AiUsageAggregationService;
  partitionKey: string;
  /** Start the step + DLQ workers (call after boss.start()). */
  start(): Promise<void>;
  /** Stop the workers. The caller keeps ownership of boss + pool. */
  stop(): Promise<void>;
}

export function createAiRuntime(deps: CreateAiRuntimeDeps): AiRuntime {
  const { pool, boss, host } = deps;
  const logger = deps.logger.child({ component: 'ai-runtime' });

  const usageStore = createAiUsageStore(pool);
  const usage = createAiUsageAggregationService({ store: usageStore, logger });
  const quota = createAiQuotaService({
    store: usageStore,
    // One fixed limit set for the single scope. A multi-tenant host resolves
    // per-scope limits here (and returns null to exempt BYOK scopes).
    getQuota: () => DEFAULT_AI_QUOTA,
  });

  const engine = createAiEngine({
    store: createPgWorkflowStore({ pool, partitionKey: AI_PARTITION_KEY }),
    dispatcher: createPgBossDispatcher({ boss, queueName: AI_STEP_QUEUE, partitionKey: AI_PARTITION_KEY }),
    partitionKey: AI_PARTITION_KEY,
    host,
    logger,
    usageRecorder: createAiUsageRecorder({ pool, aggregation: usage, partitionKey: AI_PARTITION_KEY, logger }),
    quotaPolicy: { checkQuota: () => quota.checkQuota(AI_PARTITION_KEY) },
  });

  const stepWorker = createPgBossStepWorker({
    boss,
    queueName: AI_STEP_QUEUE,
    logger,
    workerOptions: { pollingIntervalSeconds: 1 },
  });
  const dlqWorker = createPgBossDlqWorker({ boss, queueName: AI_STEP_QUEUE, logger, pollingIntervalSeconds: 5 });

  return {
    engine,
    usage,
    partitionKey: AI_PARTITION_KEY,
    async start() {
      await stepWorker.start(async (payload) => {
        await engine.executeStep(payload.workflowId, payload.stepId);
      });
      await dlqWorker.start(async (payload) => {
        await engine.handleStepExhausted(payload.workflowId, payload.stepId, 'step retries exhausted');
      });
    },
    async stop() {
      await dlqWorker.stop();
      await stepWorker.stop();
    },
  };
}
