// Both composables register lifecycle hooks (`onMounted`, `onScopeDispose`),
// so they need a real component instance rather than a bare call.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useActiveAiWorkflowProbe } from './useActiveAiWorkflowProbe.ts';
import { useAiWorkflowGuard } from './useAiWorkflowGuard.ts';
import type { AiWorkflowData, AiWorkflowStatus } from './core/types.ts';

function workflow(status: AiWorkflowStatus, over: Partial<AiWorkflowData> = {}): AiWorkflowData {
  return {
    id: 1,
    type: 'contact-brief',
    status,
    input: {},
    output: null,
    error: null,
    entityRef: 'contact:1',
    totalSteps: 3,
    completedSteps: status === 'completed' ? 3 : 1,
    failedSteps: 0,
    steps: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    appliedAt: null,
    ...over,
  };
}

/** Mount a composable inside a throwaway component and hand back its result. */
function mountComposable<T>(setup: () => T) {
  let exposed!: T;
  const wrapper = mount(
    defineComponent({
      setup() {
        exposed = setup();
        return () => h('div');
      },
    }),
  );
  return { result: exposed, wrapper };
}

describe('useActiveAiWorkflowProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks on mount and reports the answer', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);

    const { result } = mountComposable(() =>
      useActiveAiWorkflowProbe({ entityRef: 'contact:1', fetchHasActive }),
    );
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledWith('contact:1'));

    expect(result.hasActive.value).toBe(true);
  });

  it('does not call the transport when there is no entity to probe', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);

    mountComposable(() => useActiveAiWorkflowProbe({ entityRef: undefined, fetchHasActive }));
    await nextTick();

    expect(fetchHasActive).not.toHaveBeenCalled();
  });

  it('polls while active and stops once the answer turns false', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);

    mountComposable(() =>
      useActiveAiWorkflowProbe({ entityRef: 'contact:1', fetchHasActive, intervalMs: 1000 }),
    );
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchHasActive).toHaveBeenCalledTimes(3);

    // The run finished: polling must stop, or a trigger button stays disabled
    // and the page keeps talking to the server forever.
    fetchHasActive.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const callsWhenSettled = fetchHasActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchHasActive).toHaveBeenCalledTimes(callsWhenSettled);
  });

  it('keeps the last answer when the transport reports null (unknown)', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);
    const { result } = mountComposable(() =>
      useActiveAiWorkflowProbe({ entityRef: 'contact:1', fetchHasActive, intervalMs: 1000 }),
    );
    await vi.waitFor(() => expect(result.hasActive.value).toBe(true));

    fetchHasActive.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(result.hasActive.value).toBe(true);
  });

  it('swallows a transport error and keeps polling', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);
    mountComposable(() =>
      useActiveAiWorkflowProbe({ entityRef: 'contact:1', fetchHasActive, intervalMs: 1000 }),
    );
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledTimes(1));

    fetchHasActive.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchHasActive.mock.calls.length).toBeGreaterThan(2);
  });

  it('re-checks from scratch when the entity changes', async () => {
    const entityRef = ref('contact:1');
    const fetchHasActive = vi.fn().mockResolvedValue(false);

    mountComposable(() => useActiveAiWorkflowProbe({ entityRef, fetchHasActive }));
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledWith('contact:1'));

    entityRef.value = 'contact:2';
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledWith('contact:2'));
  });

  it('stops polling when the owning scope is disposed', async () => {
    const fetchHasActive = vi.fn().mockResolvedValue(true);
    const { wrapper } = mountComposable(() =>
      useActiveAiWorkflowProbe({ entityRef: 'contact:1', fetchHasActive, intervalMs: 1000 }),
    );
    await vi.waitFor(() => expect(fetchHasActive).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);

    wrapper.unmount();
    const callsAtUnmount = fetchHasActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchHasActive).toHaveBeenCalledTimes(callsAtUnmount);
  });
});

describe('useAiWorkflowGuard', () => {
  it('rehydrates a run that was already in flight and resumes polling', async () => {
    // The behaviour the demo verified in a browser: a workflow triggered
    // elsewhere is picked up by a page that mounts afterwards.
    const checkFn = vi.fn().mockResolvedValue(workflow('running'));
    const pollFn = vi.fn().mockResolvedValue(workflow('running'));

    const { result } = mountComposable(() => useAiWorkflowGuard({ checkFn, pollFn }));
    await vi.waitFor(() => expect(result.isChecking.value).toBe(false));

    expect(result.isActive.value).toBe(true);
    // `start` polls immediately, so the transport is already engaged.
    await vi.waitFor(() => expect(pollFn).toHaveBeenCalled());
  });

  it('shows a terminal workflow without polling it', async () => {
    const checkFn = vi.fn().mockResolvedValue(workflow('completed'));
    const pollFn = vi.fn().mockResolvedValue(workflow('completed'));

    const { result } = mountComposable(() => useAiWorkflowGuard({ checkFn, pollFn }));
    await vi.waitFor(() => expect(result.isChecking.value).toBe(false));

    expect(result.isCompleted.value).toBe(true);
    expect(pollFn).not.toHaveBeenCalled();
  });

  it('clears isChecking when the check fails, so the UI never hangs on it', async () => {
    const checkFn = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = mountComposable(() =>
      useAiWorkflowGuard({ checkFn, pollFn: vi.fn().mockResolvedValue(null) }),
    );

    await vi.waitFor(() => expect(result.isChecking.value).toBe(false));
    expect(result.workflow.value).toBeNull();
  });

  it('refuses to trigger while a workflow is active', async () => {
    const checkFn = vi.fn().mockResolvedValue(workflow('running'));
    const pollFn = vi.fn().mockResolvedValue(workflow('running'));
    const triggerFn = vi.fn().mockResolvedValue(undefined);

    const { result } = mountComposable(() => useAiWorkflowGuard({ checkFn, pollFn }));
    await vi.waitFor(() => expect(result.isActive.value).toBe(true));

    // The guard's reason for existing: a second run on the same entity costs
    // real tokens and produces a result nobody asked for.
    await expect(result.trigger(triggerFn)).resolves.toBe(false);
    expect(triggerFn).not.toHaveBeenCalled();
  });

  it('triggers and starts polling when nothing is running', async () => {
    const checkFn = vi.fn().mockResolvedValue(null);
    const pollFn = vi.fn().mockResolvedValue(workflow('running'));
    const triggerFn = vi.fn().mockResolvedValue(undefined);

    const { result } = mountComposable(() => useAiWorkflowGuard({ checkFn, pollFn }));
    await vi.waitFor(() => expect(result.isChecking.value).toBe(false));

    await expect(result.trigger(triggerFn)).resolves.toBe(true);
    expect(triggerFn).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(pollFn).toHaveBeenCalled());
  });

  it('reports false when the trigger call itself fails', async () => {
    const checkFn = vi.fn().mockResolvedValue(null);
    const pollFn = vi.fn().mockResolvedValue(null);

    const { result } = mountComposable(() => useAiWorkflowGuard({ checkFn, pollFn }));
    await vi.waitFor(() => expect(result.isChecking.value).toBe(false));

    await expect(result.trigger(() => Promise.reject(new Error('429')))).resolves.toBe(false);
    expect(pollFn).not.toHaveBeenCalled();
  });
});
