import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import type { TrackedWorkflow } from './progressCore.ts';
import { isActiveStatus, type AiWorkflowStatus } from './types.ts';

/** The slice of the progress store the card state machine needs. */
export interface AiProgressLike {
  getByEntityRef: (entityRef: string) => TrackedWorkflow | undefined;
  dismiss: (workflowId: number) => void;
}

/**
 * Shared state machine for AI trigger/suggestion cards. Derives the card
 * phase from the workflow tracked in the (injected) progress store for the
 * given entityRef.
 */
export function useAiCardState(
  store: AiProgressLike,
  entityRef: MaybeRefOrGetter<string>,
  hasActiveWorkflow?: MaybeRefOrGetter<boolean | undefined>,
) {
  const trackedWorkflow = computed(() => store.getByEntityRef(toValue(entityRef)));

  const cardState = computed<'active' | 'failed' | 'idle'>(() => {
    const tracked = trackedWorkflow.value;
    if (tracked) {
      if (isActiveStatus(tracked.status as AiWorkflowStatus)) return 'active';
      if (tracked.status === 'failed') return 'failed';
    }
    if (toValue(hasActiveWorkflow)) return 'active';
    return 'idle';
  });

  const failedWorkflow = computed(() => {
    const tracked = trackedWorkflow.value;
    return tracked?.status === 'failed' ? tracked : null;
  });

  function dismissFailure() {
    if (failedWorkflow.value) {
      store.dismiss(failedWorkflow.value.workflowId);
    }
  }

  return {
    trackedWorkflow,
    cardState,
    failedWorkflow,
    dismissFailure,
  };
}
