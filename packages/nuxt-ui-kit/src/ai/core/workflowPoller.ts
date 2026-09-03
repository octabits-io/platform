import type { AiWorkflowData, AiWorkflowStatus } from './types.ts';
import { isActiveStatus, isTerminalStatus } from './types.ts';
import { createPausableInterval } from './interval.ts';
import { createStore, type Observable } from './observable.ts';

export type PollFn<TOutput> = () => Promise<AiWorkflowData<TOutput> | null>;

export interface WorkflowPollerOptions<TOutput> {
  /** Polling interval in milliseconds (default: 2000) */
  interval?: number;
  /** Called when workflow completes successfully */
  onCompleted?: (workflow: AiWorkflowData<TOutput>) => void;
  /** Called when workflow fails */
  onFailed?: (workflow: AiWorkflowData<TOutput>) => void;
  /** Called when workflow is cancelled */
  onCancelled?: (workflow: AiWorkflowData<TOutput>) => void;
}

export interface WorkflowPollerState<TOutput> {
  workflow: AiWorkflowData<TOutput> | null;
  /** True from `start` until the first poll answers (or `refresh` settles). */
  isLoading: boolean;
  /** True while the interval is running. */
  isPolling: boolean;
}

/** Everything a surface derives from the polled workflow, as plain values. */
export interface WorkflowView<TOutput> {
  status: AiWorkflowStatus | null;
  /** 0..1 */
  progress: number;
  isCompleted: boolean;
  isFailed: boolean;
  isCancelled: boolean;
  isTerminal: boolean;
  isActive: boolean;
  output: TOutput | null;
  error: string | null;
}

export function deriveWorkflowView<TOutput>(workflow: AiWorkflowData<TOutput> | null): WorkflowView<TOutput> {
  const status = workflow?.status ?? null;
  return {
    status,
    progress: workflow && workflow.totalSteps > 0 ? workflow.completedSteps / workflow.totalSteps : 0,
    isCompleted: status === 'completed',
    isFailed: status === 'failed',
    isCancelled: status === 'cancelled',
    isTerminal: status != null && isTerminalStatus(status),
    isActive: status != null && isActiveStatus(status),
    output: workflow?.output ?? null,
    error: workflow?.error ?? null,
  };
}

/**
 * Poll-driven AI-workflow state: `start(pollFn)` fetches immediately and then
 * polls until the workflow reaches a terminal status, firing the matching
 * callback. The poll function is injected — the engine is transport-agnostic —
 * and so is the reactivity: this is a plain observable, bound to a framework
 * by an adapter (`../useAiWorkflow.ts` for Vue).
 */
export function createWorkflowPoller<TOutput = unknown>(options: WorkflowPollerOptions<TOutput> = {}) {
  const { interval = 2000, onCompleted, onFailed, onCancelled } = options;

  const store = createStore<WorkflowPollerState<TOutput>>({ workflow: null, isLoading: false, isPolling: false });
  const patch = (partial: Partial<WorkflowPollerState<TOutput>>) => store.set({ ...store.get(), ...partial });

  let activePollFn: PollFn<TOutput> | null = null;

  function notifyTerminal(data: AiWorkflowData<TOutput>) {
    if (data.status === 'completed') onCompleted?.(data);
    else if (data.status === 'failed') onFailed?.(data);
    else if (data.status === 'cancelled') onCancelled?.(data);
  }

  async function poll() {
    if (!activePollFn) return;

    try {
      const data = await activePollFn();
      if (!data) return;

      const previous = store.get().workflow;
      patch({ workflow: data });

      if (isTerminalStatus(data.status)) {
        timer.pause();
        // Notify on the transition only: a refresh of a run that was already
        // terminal (re-reading it after an apply) is not a completion.
        const wasTerminal = previous !== null && isTerminalStatus(previous.status);
        if (!wasTerminal) notifyTerminal(data);
      }
    } catch {
      // Silently ignore poll errors — next poll will retry
    }
  }

  const timer = createPausableInterval(poll, interval, (isPolling) => patch({ isPolling }));

  function start(pollFn: PollFn<TOutput>) {
    activePollFn = pollFn;
    patch({ isLoading: true });

    // Kick off first poll immediately, then start interval
    pollFn()
      .then((data) => {
        patch({ workflow: data ?? store.get().workflow, isLoading: false });
        if (!data || !isTerminalStatus(data.status)) {
          timer.resume();
        } else {
          notifyTerminal(data);
        }
      })
      .catch(() => {
        patch({ isLoading: false });
      });
  }

  /**
   * Remember a poll function without starting the interval — for a run that
   * is already terminal when the host learns about it. `refresh` then re-reads
   * it on demand (after an apply, say), while nothing polls a finished run.
   */
  function attach(pollFn: PollFn<TOutput>) {
    activePollFn = pollFn;
  }

  function stop() {
    timer.pause();
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
    if (!activePollFn) return;
    patch({ isLoading: true });
    try {
      await poll();
    } finally {
      patch({ isLoading: false });
    }
  }

  function setWorkflow(data: AiWorkflowData<TOutput>) {
    patch({ workflow: data });
  }

  const observable: Observable<WorkflowPollerState<TOutput>> = { get: store.get, subscribe: store.subscribe };

  return {
    ...observable,
    start,
    attach,
    stop,
    cancel,
    refresh,
    setWorkflow,
    /** One poll cycle, on demand. Exposed for hosts that drive it from a push channel. */
    poll,
  };
}

export type WorkflowPoller<TOutput> = ReturnType<typeof createWorkflowPoller<TOutput>>;
