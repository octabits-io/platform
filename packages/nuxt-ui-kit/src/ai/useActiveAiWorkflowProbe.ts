import { ref, watch, toValue, onMounted, onScopeDispose, type MaybeRef } from 'vue';
import { createPausableInterval } from './interval.ts';

export interface ActiveAiWorkflowProbeOptions {
  /** The entity the probe watches; `undefined` disables checking. */
  entityRef: MaybeRef<string | undefined>;
  /** Report whether an active workflow exists for the entity; `null` = unknown (keep last). */
  fetchHasActive: (entityRef: string) => Promise<boolean | null>;
  /** Poll cadence while a workflow is active. Default 3000ms. */
  intervalMs?: number;
}

/**
 * "Is something already running for this entity?" probe: checks on mount and
 * whenever the entity changes, then polls while active so trigger buttons can
 * disable themselves. Transport is injected.
 */
export function useActiveAiWorkflowProbe(options: ActiveAiWorkflowProbeOptions) {
  const hasActive = ref(false);
  const isChecking = ref(false);

  async function refresh() {
    const ref_ = toValue(options.entityRef);
    if (!ref_) return;

    isChecking.value = true;
    try {
      const result = await options.fetchHasActive(ref_);
      if (result !== null) hasActive.value = result;
    } catch {
      // Silently ignore — next poll will retry
    } finally {
      isChecking.value = false;
    }
  }

  // Poll while active, pause when not
  const { pause, resume } = createPausableInterval(refresh, options.intervalMs ?? 3000);

  watch(hasActive, (active) => {
    if (active) resume();
    else pause();
  });

  // Re-check when entityRef changes
  watch(() => toValue(options.entityRef), () => {
    hasActive.value = false;
    refresh();
  });

  // Initial check
  onMounted(() => {
    refresh();
  });

  onScopeDispose(() => {
    pause();
  });

  return {
    hasActive,
    isChecking,
    refresh,
  };
}
