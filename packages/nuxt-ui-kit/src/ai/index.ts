// The framework-free state machines (also importable without Vue via
// `@octabits-io/nuxt-ui-kit/ai/core`). Everything below this block is the
// Vue binding of one of them.
export * from './core/index.ts';

// Poll-driven workflow state
export { useAiWorkflow } from './useAiWorkflow.ts';
export type { UseAiWorkflowOptions, UseAiWorkflowReturn } from './useAiWorkflow.ts';

// Mount-time rehydration + duplicate-safe trigger
export { useAiWorkflowGuard } from './useAiWorkflowGuard.ts';
export type { UseAiWorkflowGuardOptions, UseAiWorkflowGuardReturn } from './useAiWorkflowGuard.ts';

// Cross-page progress tracking (store core)
export { createAiProgressCore } from './progressCore.ts';
export type { AiProgressCore } from './progressCore.ts';

// Card state machine over the progress store
export { useAiCardState } from './useAiCardState.ts';
export type { AiProgressLike } from './useAiCardState.ts';

// "Already running?" probe for trigger buttons
export { useActiveAiWorkflowProbe } from './useActiveAiWorkflowProbe.ts';
export type { ActiveAiWorkflowProbeOptions } from './useActiveAiWorkflowProbe.ts';

// The Vue half of the adapter contract, for apps binding their own core objects
export { useObservable } from './useObservable.ts';
