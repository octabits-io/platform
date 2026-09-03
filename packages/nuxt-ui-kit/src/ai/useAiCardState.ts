import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import type { TrackedWorkflow } from './core/progressStore.ts';
import { deriveAiCardState } from './core/cardState.ts';

/** The slice of the progress store the card state machine needs. */
export interface AiProgressLike {
  getByEntityRef: (entityRef: string) => TrackedWorkflow | undefined;
  dismiss: (workflowId: number) => void;
}

/**
 * Shared state machine for AI trigger/suggestion cards. Derives the card
 * phase from the workflow tracked in the (injected) progress store for the
 * given entityRef.
 *
 * Vue binding of `deriveAiCardState` (core).
 */
export function useAiCardState(
  store: AiProgressLike,
  entityRef: MaybeRefOrGetter<string>,
  hasActiveWorkflow?: MaybeRefOrGetter<boolean | undefined>,
) {
  const trackedWorkflow = computed(() => store.getByEntityRef(toValue(entityRef)));
  const derived = computed(() =>
    deriveAiCardState({ tracked: trackedWorkflow.value, hasActiveWorkflow: toValue(hasActiveWorkflow) }),
  );
  const failedWorkflow = computed(() => derived.value.failedWorkflow);

  function dismissFailure() {
    if (failedWorkflow.value) {
      store.dismiss(failedWorkflow.value.workflowId);
    }
  }

  return {
    trackedWorkflow,
    cardState: computed(() => derived.value.cardState),
    failedWorkflow,
    dismissFailure,
  };
}
