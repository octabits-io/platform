// ============================================================================
// @octabits-io/nuxt-ui-kit/ai/core — the AI-UX state machines, framework-free
// ============================================================================
//
// Everything under src/ai/core imports nothing from Vue, from the rest of the
// kit, or from any vendor (lint-enforced: scripts/check-boundaries.mjs). Each
// state machine is an `Observable` — `get()` + `subscribe()` — plus actions,
// and derived values are pure functions over the state. A framework adapter
// mirrors the observable into its own reactivity and re-exports the actions;
// `../useAiWorkflow.ts` and friends are the Vue ones, and they are thin on
// purpose. A React adapter is `useSyncExternalStore` over the same objects.
//
// This is the headless core the memo said already existed. It did not: the
// state machines were written in refs and watchers. Now it does, and it is
// parked in this package until a second framework needs it under its own name.

export type { AiWorkflowStatus, AiWorkflowStepStatus, AiWorkflowStepData, AiWorkflowData } from './types.ts';
export { isTerminalStatus, isActiveStatus } from './types.ts';

export type { Observable, Store } from './observable.ts';
export { createStore } from './observable.ts';

export type { PausableInterval } from './interval.ts';
export { createPausableInterval } from './interval.ts';

export { createWorkflowPoller, deriveWorkflowView } from './workflowPoller.ts';
export type { PollFn, WorkflowPoller, WorkflowPollerOptions, WorkflowPollerState, WorkflowView } from './workflowPoller.ts';

export { createWorkflowGuard } from './workflowGuard.ts';
export type { WorkflowGuard, WorkflowGuardOptions, WorkflowGuardState } from './workflowGuard.ts';

export { createAiProgressStore, activeWorkflows, hasActiveWorkflow, trackedByEntityRef } from './progressStore.ts';
export type {
  AiProgressCoreOptions,
  AiProgressState,
  AiProgressStore,
  AiWorkflowStatusSnapshot,
  TrackedWorkflow,
} from './progressStore.ts';

export { deriveAiCardState } from './cardState.ts';
export type { AiCardPhase, AiCardState, AiCardStateInput } from './cardState.ts';

export { createActiveWorkflowProbe } from './activeProbe.ts';
export type { ActiveWorkflowProbe, ActiveWorkflowProbeOptions, ActiveWorkflowProbeState } from './activeProbe.ts';

export { createWorkflowRegistry } from './registry.ts';
export type { WorkflowRegistry, WorkflowRegistryOptions } from './registry.ts';
