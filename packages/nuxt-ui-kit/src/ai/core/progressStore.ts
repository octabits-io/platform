import { isTerminalStatus, type AiWorkflowStatus } from './types.ts';
import { createPausableInterval } from './interval.ts';
import { createStore, type Observable } from './observable.ts';

export interface TrackedWorkflow {
  workflowId: number;
  workflowType: string;
  entityRef: string | null;
  entityId?: number;
  status: AiWorkflowStatus;
  progress: number;
  totalSteps: number;
  completedSteps: number;
  dismissed: boolean;
}

export interface AiWorkflowStatusSnapshot {
  status: AiWorkflowStatus;
  totalSteps: number;
  completedSteps: number;
}

export interface AiProgressCoreOptions {
  /** Fetch the current status of one workflow; `null` skips this cycle. */
  fetchWorkflowStatus: (workflowId: number) => Promise<AiWorkflowStatusSnapshot | null>;
  /** Poll cadence while any tracked workflow is active. Default 3000ms. */
  intervalMs?: number;
  /**
   * Fired once per workflow when polling observes its transition to a
   * terminal status (completed/failed/cancelled) — alongside the
   * `completionSignal` bump, but carrying WHICH workflow finished. Use for
   * per-workflow notifications (toasts, badges).
   */
  onTerminal?: (tracked: TrackedWorkflow) => void;
}

export interface AiProgressState<TDialogRequest> {
  trackedWorkflows: readonly TrackedWorkflow[];
  /** Bumps whenever a tracked workflow transitions to terminal status. Watch this to refresh history. */
  completionSignal: number;
  /** Bumps whenever workflow results are applied (from float or sidebar). Watch this to reload page data. */
  appliedSignal: number;
  dialogRequest: TDialogRequest | null;
}

/** Tracked workflows the user has not dismissed. */
export function activeWorkflows(state: Pick<AiProgressState<unknown>, 'trackedWorkflows'>): TrackedWorkflow[] {
  return state.trackedWorkflows.filter((w) => !w.dismissed);
}

/** Is anything still running? Drives the poll loop. */
export function hasActiveWorkflow(state: Pick<AiProgressState<unknown>, 'trackedWorkflows'>): boolean {
  return state.trackedWorkflows.some((w) => !isTerminalStatus(w.status));
}

/** The undismissed workflow tracked for an entity, for inline status display. */
export function trackedByEntityRef(
  state: Pick<AiProgressState<unknown>, 'trackedWorkflows'>,
  entityRef: string,
): TrackedWorkflow | undefined {
  return state.trackedWorkflows.find((w) => w.entityRef === entityRef && !w.dismissed);
}

/**
 * Cross-page AI-workflow progress tracking: the workflows a session has
 * triggered, polled through the injected fetch while any is active, plus the
 * `completionSignal` / `appliedSignal` counters pages watch to refresh their
 * data. The dialog-request channel is generic over the app's request shape.
 *
 * Framework-free. The Vue binding is `createAiProgressCore` in
 * `../progressCore.ts`, which is what a Pinia store wraps.
 */
export function createAiProgressStore<TDialogRequest>(options: AiProgressCoreOptions) {
  const intervalMs = options.intervalMs ?? 3000;

  const store = createStore<AiProgressState<TDialogRequest>>({
    trackedWorkflows: [],
    completionSignal: 0,
    appliedSignal: 0,
    dialogRequest: null,
  });
  const patch = (partial: Partial<AiProgressState<TDialogRequest>>) => store.set({ ...store.get(), ...partial });

  function replaceTracked(workflowId: number, change: Partial<TrackedWorkflow>): TrackedWorkflow | undefined {
    let updated: TrackedWorkflow | undefined;
    const trackedWorkflows = store.get().trackedWorkflows.map((w) => {
      if (w.workflowId !== workflowId) return w;
      updated = { ...w, ...change };
      return updated;
    });
    if (updated) patch({ trackedWorkflows });
    return updated;
  }

  // Poll active workflows
  async function pollActive() {
    const active = store.get().trackedWorkflows.filter((w) => !isTerminalStatus(w.status));
    if (active.length === 0) return;

    for (const tracked of active) {
      try {
        const workflow = await options.fetchWorkflowStatus(tracked.workflowId);
        if (!workflow) continue;

        const wasActive = !isTerminalStatus(tracked.status);
        const updated = replaceTracked(tracked.workflowId, {
          status: workflow.status,
          totalSteps: workflow.totalSteps,
          completedSteps: workflow.completedSteps,
          progress: workflow.totalSteps > 0 ? (workflow.completedSteps / workflow.totalSteps) * 100 : 0,
        });
        // Untracked while the fetch was in flight — nothing to report.
        if (!updated) continue;

        // Signal when a workflow just transitioned to terminal (for history refresh)
        if (wasActive && isTerminalStatus(workflow.status)) {
          patch({ completionSignal: store.get().completionSignal + 1 });
          options.onTerminal?.(updated);
        }

        // Terminal workflows stay visible until the user dismisses or clicks
        // to review — the consumer's activity UI handles dismiss-on-apply.
      } catch {
        // Silently ignore — next poll will retry
      }
    }
    syncPolling();
  }

  const timer = createPausableInterval(pollActive, intervalMs);

  /** Poll exactly while something is active. Called after every change to the tracked set. */
  function syncPolling() {
    if (hasActiveWorkflow(store.get())) timer.resume();
    else timer.pause();
  }

  function track(workflowId: number, workflowType: string, entityRef: string | null, entityId?: number) {
    // Don't add duplicates
    if (store.get().trackedWorkflows.some((w) => w.workflowId === workflowId)) return;

    patch({
      trackedWorkflows: [
        ...store.get().trackedWorkflows,
        {
          workflowId,
          workflowType,
          entityRef,
          entityId,
          status: 'pending',
          progress: 0,
          totalSteps: 0,
          completedSteps: 0,
          dismissed: false,
        },
      ],
    });
    syncPolling();
  }

  function dismiss(workflowId: number) {
    replaceTracked(workflowId, { dismissed: true });
  }

  /** Mark a workflow as applied and signal listeners to reload data. */
  function markApplied(workflowId: number) {
    dismiss(workflowId);
    patch({ appliedSignal: store.get().appliedSignal + 1 });
  }

  function untrack(workflowId: number) {
    patch({ trackedWorkflows: store.get().trackedWorkflows.filter((w) => w.workflowId !== workflowId) });
    syncPolling();
  }

  function getByEntityRef(entityRef: string): TrackedWorkflow | undefined {
    return trackedByEntityRef(store.get(), entityRef);
  }

  function openDialog(request: TDialogRequest) {
    patch({ dialogRequest: request });
  }

  function closeDialog() {
    patch({ dialogRequest: null });
  }

  function reset() {
    store.set({ trackedWorkflows: [], completionSignal: 0, appliedSignal: 0, dialogRequest: null });
    timer.pause();
  }

  const observable: Observable<AiProgressState<TDialogRequest>> = { get: store.get, subscribe: store.subscribe };

  return {
    ...observable,
    track,
    dismiss,
    markApplied,
    untrack,
    getByEntityRef,
    openDialog,
    closeDialog,
    pollActive,
    reset,
  };
}

export type AiProgressStore<TDialogRequest> = ReturnType<typeof createAiProgressStore<TDialogRequest>>;
