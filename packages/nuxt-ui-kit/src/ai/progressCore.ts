import { ref, computed, watch, type Ref } from 'vue';
import { isTerminalStatus, type AiWorkflowStatus } from './types.ts';
import { createPausableInterval } from './interval.ts';

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

/**
 * Cross-page AI-workflow progress tracking — the setup body of an app's
 * progress store (`defineStore('ai-progress', () => createAiProgressCore(…))`).
 * Tracks triggered workflows, polls the active ones through the injected
 * fetch, and exposes `completionSignal` / `appliedSignal` counters pages watch
 * to refresh their data. The dialog-request channel is generic over the app's
 * request shape (typically `{ definition, entityId?, entityRef?, workflowId? }`).
 */
export function createAiProgressCore<TDialogRequest>(options: AiProgressCoreOptions) {
  const intervalMs = options.intervalMs ?? 3000;

  const trackedWorkflows = ref<TrackedWorkflow[]>([]);
  // Explicit Ref annotation: the inferred type of a generic ref would drag
  // @vue/shared internals (IfAny) into the emitted declarations (TS2883).
  const dialogRequest = ref(null) as Ref<TDialogRequest | null>;

  /** Bumps whenever a tracked workflow transitions to terminal status. Watch this to refresh history. */
  const completionSignal = ref(0);

  /** Bumps whenever workflow results are applied (from float or sidebar). Watch this to reload page data. */
  const appliedSignal = ref(0);

  const activeWorkflows = computed(() =>
    trackedWorkflows.value.filter((w) => !w.dismissed),
  );

  const hasActive = computed(() =>
    trackedWorkflows.value.some((w) => !isTerminalStatus(w.status)),
  );

  function track(workflowId: number, workflowType: string, entityRef: string | null, entityId?: number) {
    // Don't add duplicates
    if (trackedWorkflows.value.some((w) => w.workflowId === workflowId)) return;

    trackedWorkflows.value.push({
      workflowId,
      workflowType,
      entityRef,
      entityId,
      status: 'pending',
      progress: 0,
      totalSteps: 0,
      completedSteps: 0,
      dismissed: false,
    });
  }

  function dismiss(workflowId: number) {
    const w = trackedWorkflows.value.find((w) => w.workflowId === workflowId);
    if (w) w.dismissed = true;
  }

  /** Mark a workflow as applied and signal listeners to reload data. */
  function markApplied(workflowId: number) {
    dismiss(workflowId);
    appliedSignal.value++;
  }

  function untrack(workflowId: number) {
    trackedWorkflows.value = trackedWorkflows.value.filter((w) => w.workflowId !== workflowId);
  }

  /** Find a tracked workflow by entityRef (for inline status display) */
  function getByEntityRef(entityRef: string): TrackedWorkflow | undefined {
    return trackedWorkflows.value.find((w) => w.entityRef === entityRef && !w.dismissed);
  }

  // Poll active workflows
  async function pollActive() {
    const active = trackedWorkflows.value.filter((w) => !isTerminalStatus(w.status));
    if (active.length === 0) return;

    for (const tracked of active) {
      try {
        const workflow = await options.fetchWorkflowStatus(tracked.workflowId);
        if (!workflow) continue;

        const wasActive = !isTerminalStatus(tracked.status);
        tracked.status = workflow.status;
        tracked.totalSteps = workflow.totalSteps;
        tracked.completedSteps = workflow.completedSteps;
        tracked.progress = workflow.totalSteps > 0
          ? (workflow.completedSteps / workflow.totalSteps) * 100
          : 0;

        // Signal when a workflow just transitioned to terminal (for history refresh)
        if (wasActive && isTerminalStatus(workflow.status)) {
          completionSignal.value++;
          options.onTerminal?.(tracked);
        }

        // Terminal workflows stay visible until the user dismisses or clicks
        // to review — the consumer's activity UI handles dismiss-on-apply.
      } catch {
        // Silently ignore — next poll will retry
      }
    }
  }

  const { pause, resume } = createPausableInterval(pollActive, intervalMs);

  watch(hasActive, (active) => {
    if (active) resume();
    else pause();
  });

  // Start polling if there are already active items when the store is created
  watch(trackedWorkflows, () => {
    if (hasActive.value) resume();
  }, { deep: true });

  function openDialog(request: TDialogRequest) {
    dialogRequest.value = request;
  }

  function closeDialog() {
    dialogRequest.value = null;
  }

  function reset() {
    trackedWorkflows.value = [];
    completionSignal.value = 0;
    appliedSignal.value = 0;
    dialogRequest.value = null;
    pause();
  }

  return {
    trackedWorkflows,
    activeWorkflows,
    hasActive,
    completionSignal,
    appliedSignal,
    dialogRequest,
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

export type AiProgressCore<TDialogRequest> = ReturnType<typeof createAiProgressCore<TDialogRequest>>;
