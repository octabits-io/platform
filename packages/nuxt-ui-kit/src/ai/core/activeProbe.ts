import { createPausableInterval } from './interval.ts';
import { createStore, type Observable } from './observable.ts';

export interface ActiveWorkflowProbeOptions {
  /** Report whether an active workflow exists for the entity; `null` = unknown (keep last). */
  fetchHasActive: (entityRef: string) => Promise<boolean | null>;
  /** Poll cadence while a workflow is active. Default 3000ms. */
  intervalMs?: number;
}

export interface ActiveWorkflowProbeState {
  hasActive: boolean;
  isChecking: boolean;
}

/**
 * "Is something already running for this entity?" probe: answers on demand
 * and polls while the answer is yes, so trigger buttons can disable
 * themselves. Transport is injected; so is the entity, via `setEntityRef`
 * (`undefined` disables checking).
 */
export function createActiveWorkflowProbe(options: ActiveWorkflowProbeOptions) {
  const store = createStore<ActiveWorkflowProbeState>({ hasActive: false, isChecking: false });
  const patch = (partial: Partial<ActiveWorkflowProbeState>) => store.set({ ...store.get(), ...partial });

  let entityRef: string | undefined;

  async function refresh() {
    const ref = entityRef;
    if (!ref) return;

    patch({ isChecking: true });
    try {
      const result = await options.fetchHasActive(ref);
      // The entity moved on while we were asking — the answer is for a stale question.
      if (ref !== entityRef) return;
      if (result !== null) setHasActive(result);
    } catch {
      // Silently ignore — next poll will retry
    } finally {
      if (ref === entityRef) patch({ isChecking: false });
    }
  }

  const timer = createPausableInterval(refresh, options.intervalMs ?? 3000);

  // Poll while active, pause when not
  function setHasActive(hasActive: boolean) {
    patch({ hasActive });
    if (hasActive) timer.resume();
    else timer.pause();
  }

  /** Point the probe at an entity. Resets the answer and, by default, asks again. */
  function setEntityRef(next: string | undefined, { refresh: doRefresh = true } = {}) {
    entityRef = next;
    setHasActive(false);
    if (doRefresh) void refresh();
  }

  function dispose() {
    timer.pause();
  }

  const observable: Observable<ActiveWorkflowProbeState> = { get: store.get, subscribe: store.subscribe };

  return { ...observable, refresh, setEntityRef, dispose };
}

export type ActiveWorkflowProbe = ReturnType<typeof createActiveWorkflowProbe>;
