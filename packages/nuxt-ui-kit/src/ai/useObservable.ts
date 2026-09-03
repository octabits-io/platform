import { getCurrentScope, onScopeDispose, shallowRef, type ShallowRef } from 'vue';
import type { Observable } from './core/observable.ts';

/**
 * The Vue half of the adapter contract: mirror a core observable into a
 * `shallowRef`, and stop mirroring when the owning effect scope goes away.
 * Called outside any scope (a bare store, a test) it simply never unsubscribes,
 * which is what a process-lifetime store wants anyway.
 */
export function useObservable<S>(source: Observable<S>): Readonly<ShallowRef<S>> {
  const state = shallowRef(source.get());
  const unsubscribe = source.subscribe((next) => {
    state.value = next;
  });
  if (getCurrentScope()) onScopeDispose(unsubscribe);
  return state;
}
