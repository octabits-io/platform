/**
 * The one primitive every core state machine in this directory is built on:
 * a value, a way to replace it, and a way to be told when it was replaced.
 *
 * It is deliberately the shape React's `useSyncExternalStore` expects
 * (`getSnapshot` + `subscribe`) and the shape a Vue `shallowRef` can mirror in
 * three lines (`useObservable` in `../useObservable.ts`). That is the entire
 * adapter contract: a framework binds an observable to its own reactivity and
 * hands the actions through untouched.
 *
 * State is replaced, never mutated — every change is a new object, so an
 * adapter can compare by identity and a snapshot handed out is safe to keep.
 */
export interface Observable<S> {
  /** The current state. */
  get(): S;
  /** Called after every replacement, with the new state. Returns unsubscribe. */
  subscribe(listener: (state: S) => void): () => void;
}

export interface Store<S> extends Observable<S> {
  set(next: S): void;
  update(fn: (current: S) => S): void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<(state: S) => void>();

  return {
    get: () => state,
    set(next) {
      if (Object.is(next, state)) return;
      state = next;
      // Copy first: a listener may unsubscribe (or subscribe) while we iterate.
      for (const listener of [...listeners]) listener(state);
    },
    update(fn) {
      this.set(fn(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
