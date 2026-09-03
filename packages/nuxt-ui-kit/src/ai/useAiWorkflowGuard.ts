import { computed, onMounted } from 'vue';
import { useAiWorkflow } from './useAiWorkflow.ts';
import type { UseAiWorkflowOptions } from './useAiWorkflow.ts';
import { createWorkflowGuard } from './core/workflowGuard.ts';
import type { WorkflowGuardOptions } from './core/workflowGuard.ts';
import { useObservable } from './useObservable.ts';

export interface UseAiWorkflowGuardOptions<TOutput> extends UseAiWorkflowOptions<TOutput>, WorkflowGuardOptions<TOutput> {}

/**
 * useAiWorkflow plus a mount-time re-hydration check (resume polling a
 * workflow that is already running) and a `trigger` that refuses to start a
 * duplicate while one is active. All transport is injected.
 *
 * Vue binding of `createWorkflowGuard` (core): mount is the moment to rehydrate.
 */
export function useAiWorkflowGuard<TOutput = unknown>(options: UseAiWorkflowGuardOptions<TOutput>) {
  const { checkFn, pollFn, ...workflowOptions } = options;
  const ai = useAiWorkflow<TOutput>(workflowOptions);
  const guard = createWorkflowGuard(ai.poller, { checkFn, pollFn });
  const state = useObservable(guard);

  onMounted(() => {
    void guard.rehydrate();
  });

  return {
    ...ai,
    isChecking: computed(() => state.value.isChecking),
    trigger: guard.trigger,
  };
}

export type UseAiWorkflowGuardReturn<TOutput> = ReturnType<typeof useAiWorkflowGuard<TOutput>>;
