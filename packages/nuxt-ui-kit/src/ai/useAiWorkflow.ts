import { computed, onScopeDispose, getCurrentScope } from 'vue';
import { createWorkflowPoller, deriveWorkflowView } from './core/workflowPoller.ts';
import type { PollFn, WorkflowPollerOptions } from './core/workflowPoller.ts';
import { useObservable } from './useObservable.ts';

export type UseAiWorkflowOptions<TOutput> = WorkflowPollerOptions<TOutput>;
export type { PollFn };

/**
 * Poll-driven AI-workflow state: `start(pollFn)` fetches immediately and then
 * polls until the workflow reaches a terminal status, firing the matching
 * callback. The poll function is injected — the engine is transport-agnostic.
 *
 * Vue binding of `createWorkflowPoller` (core): the state machine lives there;
 * this mirrors its state into refs and stops polling with the scope.
 */
export function useAiWorkflow<TOutput = unknown>(options: UseAiWorkflowOptions<TOutput> = {}) {
  const poller = createWorkflowPoller<TOutput>(options);
  const state = useObservable(poller);
  const view = computed(() => deriveWorkflowView(state.value.workflow));

  if (getCurrentScope()) onScopeDispose(() => poller.stop());

  return {
    // State
    workflow: computed(() => state.value.workflow),
    isLoading: computed(() => state.value.isLoading),
    isPolling: computed(() => state.value.isPolling),
    // Computed
    status: computed(() => view.value.status),
    progress: computed(() => view.value.progress),
    isCompleted: computed(() => view.value.isCompleted),
    isFailed: computed(() => view.value.isFailed),
    isCancelled: computed(() => view.value.isCancelled),
    isTerminal: computed(() => view.value.isTerminal),
    isActive: computed(() => view.value.isActive),
    output: computed(() => view.value.output),
    error: computed(() => view.value.error),
    // Actions
    start: poller.start,
    stop: poller.stop,
    cancel: poller.cancel,
    refresh: poller.refresh,
    setWorkflow: poller.setWorkflow,
    /** The core, for hosts that need the observable itself (a push channel driving `poll`). */
    poller,
  };
}

export type UseAiWorkflowReturn<TOutput> = ReturnType<typeof useAiWorkflow<TOutput>>;
