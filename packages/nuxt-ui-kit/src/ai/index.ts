// Workflow data model + status helpers
export type {
  AiWorkflowStatus,
  AiWorkflowStepStatus,
  AiWorkflowStepData,
  AiWorkflowData,
} from './types.ts';
export { isTerminalStatus, isActiveStatus } from './types.ts';

// Poll-driven workflow state
export { useAiWorkflow } from './useAiWorkflow.ts';
export type { UseAiWorkflowOptions, PollFn, UseAiWorkflowReturn } from './useAiWorkflow.ts';

// Mount-time rehydration + duplicate-safe trigger
export { useAiWorkflowGuard } from './useAiWorkflowGuard.ts';
export type { UseAiWorkflowGuardOptions, UseAiWorkflowGuardReturn } from './useAiWorkflowGuard.ts';

// Cross-page progress tracking (store core)
export { createAiProgressCore } from './progressCore.ts';
export type {
  AiProgressCore,
  AiProgressCoreOptions,
  AiWorkflowStatusSnapshot,
  TrackedWorkflow,
} from './progressCore.ts';

// Card state machine over the progress store
export { useAiCardState } from './useAiCardState.ts';
export type { AiProgressLike } from './useAiCardState.ts';

// "Already running?" probe for trigger buttons
export { useActiveAiWorkflowProbe } from './useActiveAiWorkflowProbe.ts';
export type { ActiveAiWorkflowProbeOptions } from './useActiveAiWorkflowProbe.ts';

// Typed workflow-type registry
export { createWorkflowRegistry } from './registry.ts';
export type { WorkflowRegistry, WorkflowRegistryOptions } from './registry.ts';
