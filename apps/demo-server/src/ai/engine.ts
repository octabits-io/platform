/**
 * The store/dispatcher-agnostic middle of the AI wiring.
 *
 * `createAiEngine` assembles registry + AI hooks + engine and is deliberately
 * generic over `WorkflowStore` and `Dispatcher`: `runtime.ts` feeds it the
 * Postgres store and the pg-boss dispatcher, while `ai.test.ts` feeds it the
 * in-memory store and an array-backed dispatcher — same registry, same hooks,
 * same mock model, zero test-only branches in here.
 */
import type { Dispatcher, WorkflowStore } from '@octabits-io/flow';
import { createStepHandlerRegistry, createWorkflowEngine, type WorkflowEngine } from '@octabits-io/flow';
import {
  createAiWorkflowHooks,
  createCostEstimator,
  type AiContext,
  type AiQuotaPolicy,
  type AiUsageRecorder,
} from '@octabits-io/flow/ai';
import type { Logger } from '@octabits-io/framework/logger';
import { createDemoAiModel, DEMO_MODEL_PRICING } from './model.ts';
import { aiWorkflowsByType, type AiHost } from './workflows.ts';

export type DemoAiEngine = WorkflowEngine<AiContext<AiHost>>;

export interface CreateAiEngineDeps {
  store: WorkflowStore;
  dispatcher: Dispatcher;
  partitionKey: string;
  host: AiHost;
  logger: Logger;
  usageRecorder: AiUsageRecorder;
  quotaPolicy?: AiQuotaPolicy;
}

export function createAiEngine(deps: CreateAiEngineDeps): DemoAiEngine {
  const model = createDemoAiModel();

  const hooks = createAiWorkflowHooks<AiHost>({
    modelResolver: {
      // One scripted model for every step. A real app would pick per workflow
      // type or per scope here (args carries the workflow + step records).
      resolveModel: () => model,
      resolveHost: () => deps.host,
      // Single-scope demo: the platform always pays. A BYOK host would return
      // 'tenant' when the scope brought its own key.
      resolveKeySource: () => 'platform',
    },
    usageRecorder: deps.usageRecorder,
    quotaPolicy: deps.quotaPolicy,
    costEstimator: createCostEstimator({ pricing: DEMO_MODEL_PRICING }),
  });

  const registry = createStepHandlerRegistry<AiContext<AiHost>>();
  for (const workflow of Object.values(aiWorkflowsByType)) workflow.register(registry);

  return createWorkflowEngine<AiContext<AiHost>>({
    store: deps.store,
    dispatcher: deps.dispatcher,
    registry,
    partitionKey: deps.partitionKey,
    logger: deps.logger,
    hooks,
  });
}
