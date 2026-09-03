import type { AiWorkflowData } from './types.ts';
import { isActiveStatus } from './types.ts';
import { deriveWorkflowView, type PollFn, type WorkflowPoller } from './workflowPoller.ts';
import { createStore, type Observable } from './observable.ts';

export interface WorkflowGuardOptions<TOutput> {
  /** Check for an existing workflow (typically on mount). Returns the workflow data or null. */
  checkFn: () => Promise<AiWorkflowData<TOutput> | null>;
  /** Poll function used for ongoing status checks (typically same endpoint as checkFn) */
  pollFn: PollFn<TOutput>;
}

export interface WorkflowGuardState {
  /** True until `rehydrate` has settled. */
  isChecking: boolean;
}

/**
 * A poller plus a re-hydration check (resume polling a workflow that is
 * already running) and a `trigger` that refuses to start a duplicate while
 * one is active. All transport is injected; the host decides when to
 * rehydrate (a Vue adapter does it on mount).
 */
export function createWorkflowGuard<TOutput>(poller: WorkflowPoller<TOutput>, options: WorkflowGuardOptions<TOutput>) {
  const { checkFn, pollFn } = options;
  const store = createStore<WorkflowGuardState>({ isChecking: true });

  async function rehydrate() {
    try {
      const existing = await checkFn();
      if (existing && isActiveStatus(existing.status)) {
        poller.setWorkflow(existing);
        poller.start(pollFn);
      } else if (existing) {
        // Terminal workflow — show its state but don't poll
        poller.setWorkflow(existing);
      }
    } catch {
      // ignore check errors
    } finally {
      store.set({ isChecking: false });
    }
  }

  /**
   * Trigger a new workflow. Calls the provided trigger function,
   * then starts polling with the configured pollFn.
   * Returns false if a workflow is already active.
   */
  async function trigger(triggerFn: () => Promise<void>): Promise<boolean> {
    if (deriveWorkflowView(poller.get().workflow).isActive) return false;

    try {
      await triggerFn();
      poller.start(pollFn);
      return true;
    } catch {
      return false;
    }
  }

  const observable: Observable<WorkflowGuardState> = { get: store.get, subscribe: store.subscribe };

  return { ...observable, rehydrate, trigger };
}

export type WorkflowGuard<TOutput> = ReturnType<typeof createWorkflowGuard<TOutput>>;
