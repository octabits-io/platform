import { ref, computed, shallowRef, onScopeDispose } from 'vue';
import type { AiWorkflowData, AiWorkflowStatus } from './types.ts';
import { isTerminalStatus, isActiveStatus } from './types.ts';
import { createPausableInterval } from './interval.ts';

export interface UseAiWorkflowOptions<TOutput> {
  /** Polling interval in milliseconds (default: 2000) */
  interval?: number;
  /** Called when workflow completes successfully */
  onCompleted?: (workflow: AiWorkflowData<TOutput>) => void;
  /** Called when workflow fails */
  onFailed?: (workflow: AiWorkflowData<TOutput>) => void;
  /** Called when workflow is cancelled */
  onCancelled?: (workflow: AiWorkflowData<TOutput>) => void;
}

export type PollFn<TOutput> = () => Promise<AiWorkflowData<TOutput> | null>;

/**
 * Poll-driven AI-workflow state: `start(pollFn)` fetches immediately and then
 * polls until the workflow reaches a terminal status, firing the matching
 * callback. The poll function is injected — the engine is transport-agnostic.
 */
export function useAiWorkflow<TOutput = unknown>(options: UseAiWorkflowOptions<TOutput> = {}) {
  const { interval = 2000, onCompleted, onFailed, onCancelled } = options;

  const workflow = shallowRef<AiWorkflowData<TOutput> | null>(null);
  const isLoading = ref(false);

  let activePollFn: PollFn<TOutput> | null = null;

  const status = computed<AiWorkflowStatus | null>(() => workflow.value?.status ?? null);
  const isCompleted = computed(() => status.value === 'completed');
  const isFailed = computed(() => status.value === 'failed');
  const isCancelled = computed(() => status.value === 'cancelled');
  const isTerminal = computed(() => status.value != null && isTerminalStatus(status.value));
  const isActive = computed(() => status.value != null && isActiveStatus(status.value));
  const output = computed<TOutput | null>(() => workflow.value?.output ?? null);
  const error = computed<string | null>(() => workflow.value?.error ?? null);

  const progress = computed(() => {
    if (!workflow.value || workflow.value.totalSteps === 0) return 0;
    return workflow.value.completedSteps / workflow.value.totalSteps;
  });

  async function poll() {
    if (!activePollFn) return;

    try {
      const data = await activePollFn();
      if (!data) return;

      workflow.value = data;

      if (isTerminalStatus(data.status)) {
        stopPolling();
        if (data.status === 'completed') onCompleted?.(data);
        else if (data.status === 'failed') onFailed?.(data);
        else if (data.status === 'cancelled') onCancelled?.(data);
      }
    } catch {
      // Silently ignore poll errors — next poll will retry
    }
  }

  const { pause: stopPolling, resume: resumePolling, isActive: isPolling } =
    createPausableInterval(poll, interval);

  function start(pollFn: PollFn<TOutput>) {
    activePollFn = pollFn;
    isLoading.value = true;

    // Kick off first poll immediately, then start interval
    pollFn().then((data) => {
      if (data) workflow.value = data;
      isLoading.value = false;
      if (!data || !isTerminalStatus(data.status)) {
        resumePolling();
      } else {
        if (data.status === 'completed') onCompleted?.(data);
        else if (data.status === 'failed') onFailed?.(data);
        else if (data.status === 'cancelled') onCancelled?.(data);
      }
    }).catch(() => {
      isLoading.value = false;
    });
  }

  function stop() {
    stopPolling();
    activePollFn = null;
  }

  async function cancel(cancelFn: () => Promise<void>) {
    try {
      await cancelFn();
      // Poll once more to get updated status
      await poll();
    } catch {
      // ignore cancel errors
    }
  }

  async function refresh() {
    if (activePollFn) {
      isLoading.value = true;
      try {
        await poll();
      } finally {
        isLoading.value = false;
      }
    }
  }

  function setWorkflow(data: AiWorkflowData<TOutput>) {
    workflow.value = data;
  }

  onScopeDispose(() => {
    stop();
  });

  return {
    // State
    workflow,
    isLoading,
    isPolling,
    // Computed
    status,
    progress,
    isCompleted,
    isFailed,
    isCancelled,
    isTerminal,
    isActive,
    output,
    error,
    // Actions
    start,
    stop,
    cancel,
    refresh,
    setWorkflow,
  };
}

export type UseAiWorkflowReturn<TOutput> = ReturnType<typeof useAiWorkflow<TOutput>>;
