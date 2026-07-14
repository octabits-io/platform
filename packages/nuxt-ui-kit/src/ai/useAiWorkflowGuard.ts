import { ref, onMounted } from 'vue';
import { useAiWorkflow } from './useAiWorkflow.ts';
import type { UseAiWorkflowOptions, PollFn } from './useAiWorkflow.ts';
import type { AiWorkflowData } from './types.ts';
import { isActiveStatus } from './types.ts';

export interface UseAiWorkflowGuardOptions<TOutput> extends UseAiWorkflowOptions<TOutput> {
  /** Check for existing active workflow on mount. Returns the workflow data or null. */
  checkFn: () => Promise<AiWorkflowData<TOutput> | null>;
  /** Poll function used for ongoing status checks (typically same endpoint as checkFn) */
  pollFn: PollFn<TOutput>;
}

/**
 * useAiWorkflow plus a mount-time re-hydration check (resume polling a
 * workflow that is already running) and a `trigger` that refuses to start a
 * duplicate while one is active. All transport is injected.
 */
export function useAiWorkflowGuard<TOutput = unknown>(options: UseAiWorkflowGuardOptions<TOutput>) {
  const { checkFn, pollFn, ...workflowOptions } = options;
  const ai = useAiWorkflow<TOutput>(workflowOptions);
  const isChecking = ref(true);

  onMounted(async () => {
    try {
      const existing = await checkFn();
      if (existing && isActiveStatus(existing.status)) {
        ai.setWorkflow(existing);
        ai.start(pollFn);
      } else if (existing) {
        // Terminal workflow — show its state but don't poll
        ai.setWorkflow(existing);
      }
    } catch {
      // ignore check errors
    } finally {
      isChecking.value = false;
    }
  });

  /**
   * Trigger a new workflow. Calls the provided trigger function,
   * then starts polling with the configured pollFn.
   * Returns false if a workflow is already active.
   */
  async function trigger(triggerFn: () => Promise<void>): Promise<boolean> {
    if (ai.isActive.value) return false;

    try {
      await triggerFn();
      ai.start(pollFn);
      return true;
    } catch {
      return false;
    }
  }

  return {
    ...ai,
    isChecking,
    trigger,
  };
}

export type UseAiWorkflowGuardReturn<TOutput> = ReturnType<typeof useAiWorkflowGuard<TOutput>>;
