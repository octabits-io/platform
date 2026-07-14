import { describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { useDirtyTracking } from './useDirtyTracking.ts';

describe('useDirtyTracking', () => {
  it('starts clean and flips isDirty when a field changes', () => {
    const state = reactive({ name: 'a', price: 1 });
    const { isDirty } = useDirtyTracking(state);
    expect(isDirty.value).toBe(false);
    state.name = 'b';
    expect(isDirty.value).toBe(true);
  });

  it('getDirtyFields returns only the changed keys', () => {
    const state = reactive({ name: 'a', price: 1, tags: ['x'] });
    const { getDirtyFields } = useDirtyTracking(state);
    state.price = 2;
    state.tags.push('y');
    expect(getDirtyFields()).toEqual({ price: 2, tags: ['x', 'y'] });
  });

  it('resetInitial snapshots the current state as clean', () => {
    const state = reactive({ name: 'a' });
    const { isDirty, resetInitial } = useDirtyTracking(state);
    state.name = 'b';
    resetInitial();
    expect(isDirty.value).toBe(false);
  });

  it('resetInitial(values) assigns then snapshots', () => {
    const state = reactive({ name: 'a', price: 1 });
    const { isDirty, resetInitial } = useDirtyTracking(state);
    resetInitial({ name: 'loaded' });
    expect(state.name).toBe('loaded');
    expect(isDirty.value).toBe(false);
  });

  it('detects nested-object changes via deep compare', () => {
    const state = reactive({ config: { nested: true } });
    const { isDirty } = useDirtyTracking(state);
    state.config.nested = false;
    expect(isDirty.value).toBe(true);
  });
});
