import { computed, type Ref } from 'vue';
import { activeWorkflows, createAiProgressStore, hasActiveWorkflow, trackedByEntityRef } from './core/progressStore.ts';
import type { AiProgressCoreOptions, TrackedWorkflow } from './core/progressStore.ts';
import { useObservable } from './useObservable.ts';

export type { AiProgressCoreOptions, AiWorkflowStatusSnapshot, TrackedWorkflow } from './core/progressStore.ts';

/**
 * Cross-page AI-workflow progress tracking — the setup body of an app's
 * progress store (`defineStore('ai-progress', () => createAiProgressCore(…))`).
 * Tracks triggered workflows, polls the active ones through the injected
 * fetch, and exposes `completionSignal` / `appliedSignal` counters pages watch
 * to refresh their data. The dialog-request channel is generic over the app's
 * request shape (typically `{ definition, entityId?, entityRef?, workflowId? }`).
 *
 * Vue binding of `createAiProgressStore` (core). Every field below is a
 * computed over the core's state, so a Pinia store that spreads this return
 * value exposes them as reactive, read-only properties.
 */
export function createAiProgressCore<TDialogRequest>(options: AiProgressCoreOptions) {
  const store = createAiProgressStore<TDialogRequest>(options);
  const state = useObservable(store);

  const trackedWorkflows = computed(() => state.value.trackedWorkflows as TrackedWorkflow[]);

  return {
    trackedWorkflows,
    activeWorkflows: computed(() => activeWorkflows(state.value)),
    hasActive: computed(() => hasActiveWorkflow(state.value)),
    completionSignal: computed(() => state.value.completionSignal),
    appliedSignal: computed(() => state.value.appliedSignal),
    // Explicit Ref annotation: the inferred type of a generic computed would
    // drag @vue/shared internals (IfAny) into the emitted declarations (TS2883).
    dialogRequest: computed(() => state.value.dialogRequest) as Ref<TDialogRequest | null>,
    track: store.track,
    dismiss: store.dismiss,
    markApplied: store.markApplied,
    untrack: store.untrack,
    /** Reads through the reactive state, so a `computed` over it re-evaluates. */
    getByEntityRef: (entityRef: string) => trackedByEntityRef(state.value, entityRef),
    openDialog: store.openDialog,
    closeDialog: store.closeDialog,
    pollActive: store.pollActive,
    reset: store.reset,
    /** The core, for hosts that need the observable itself. */
    store,
  };
}

export type AiProgressCore<TDialogRequest> = ReturnType<typeof createAiProgressCore<TDialogRequest>>;
