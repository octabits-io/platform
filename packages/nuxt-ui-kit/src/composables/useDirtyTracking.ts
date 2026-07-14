import { ref, computed, type Ref } from 'vue';

function deepClone<V>(obj: V): V {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Form change-detection over a reactive state object via JSON deep-compare:
 * `isDirty` flips when any field differs from the snapshot; `resetInitial()`
 * re-snapshots after load/save (optionally assigning new values first);
 * `getDirtyFields()` yields a minimal PATCH payload.
 */
export function useDirtyTracking<T extends Record<string, unknown>>(state: T) {
  const initial = ref(deepClone(state)) as Ref<T>;
  const isDirty = computed(() => JSON.stringify(state) !== JSON.stringify(initial.value));

  function getDirtyFields(): Partial<T> {
    const dirty: Partial<T> = {};
    for (const key of Object.keys(state) as (keyof T)[]) {
      if (JSON.stringify(state[key]) !== JSON.stringify(initial.value[key])) {
        dirty[key] = state[key];
      }
    }
    return dirty;
  }

  function resetInitial(values?: Partial<T>) {
    if (values) Object.assign(state, values);
    initial.value = deepClone(state) as T;
  }

  return { isDirty, getDirtyFields, resetInitial };
}
