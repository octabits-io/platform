import { computed, watch, toValue, onMounted, onScopeDispose, type MaybeRef } from 'vue';
import { createActiveWorkflowProbe } from './core/activeProbe.ts';
import type { ActiveWorkflowProbeOptions as CoreOptions } from './core/activeProbe.ts';
import { useObservable } from './useObservable.ts';

export interface ActiveAiWorkflowProbeOptions extends CoreOptions {
  /** The entity the probe watches; `undefined` disables checking. */
  entityRef: MaybeRef<string | undefined>;
}

/**
 * "Is something already running for this entity?" probe: checks on mount and
 * whenever the entity changes, then polls while active so trigger buttons can
 * disable themselves. Transport is injected.
 *
 * Vue binding of `createActiveWorkflowProbe` (core): the lifecycle — mount,
 * entity change, scope disposal — is the only thing that lives here.
 */
export function useActiveAiWorkflowProbe(options: ActiveAiWorkflowProbeOptions) {
  const probe = createActiveWorkflowProbe(options);
  const state = useObservable(probe);

  probe.setEntityRef(toValue(options.entityRef), { refresh: false });

  // Re-check when entityRef changes
  watch(
    () => toValue(options.entityRef),
    (entityRef) => probe.setEntityRef(entityRef),
  );

  // Initial check
  onMounted(() => {
    void probe.refresh();
  });

  onScopeDispose(() => {
    probe.dispose();
  });

  return {
    hasActive: computed(() => state.value.hasActive),
    isChecking: computed(() => state.value.isChecking),
    refresh: probe.refresh,
  };
}
