/**
 * The state machines without any framework: what a second adapter would be
 * built against. The Vue-level tests (`../ai.test.ts`, `../composables.test.ts`)
 * prove the bindings keep their behaviour; these prove the behaviour lives in
 * the core, observable through `get()` / `subscribe()` alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiWorkflowData, AiWorkflowStatus } from './types.ts';
import { createStore } from './observable.ts';
import { createWorkflowPoller, deriveWorkflowView } from './workflowPoller.ts';
import { createWorkflowGuard } from './workflowGuard.ts';
import { activeWorkflows, createAiProgressStore, hasActiveWorkflow, trackedByEntityRef } from './progressStore.ts';
import { deriveAiCardState } from './cardState.ts';
import { createActiveWorkflowProbe } from './activeProbe.ts';

const wf = (status: AiWorkflowStatus, over: Partial<AiWorkflowData> = {}): AiWorkflowData => ({
  id: 1,
  type: 'demo',
  status,
  input: null,
  output: null,
  error: null,
  entityRef: 'listing:1',
  totalSteps: 4,
  completedSteps: status === 'completed' ? 4 : 1,
  failedSteps: 0,
  steps: [],
  createdAt: '',
  startedAt: null,
  completedAt: null,
  appliedAt: null,
  ...over,
});

describe('createStore', () => {
  it('replaces state and notifies subscribers, skipping identical values', () => {
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.n));

    store.set({ n: 1 });
    const same = store.get();
    store.set(same);
    store.update((s) => ({ n: s.n + 1 }));
    unsubscribe();
    store.set({ n: 9 });

    expect(seen).toEqual([1, 2]);
    expect(store.get().n).toBe(9);
  });

  it('tolerates a listener unsubscribing during notification', () => {
    const store = createStore(0);
    const second = vi.fn();
    const first = store.subscribe(() => first());
    store.subscribe(second);

    expect(() => store.set(1)).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('deriveWorkflowView', () => {
  it('is empty for no workflow and complete for a finished one', () => {
    expect(deriveWorkflowView(null)).toMatchObject({ status: null, progress: 0, isTerminal: false, isActive: false });
    expect(deriveWorkflowView(wf('completed', { output: { ok: 1 } }))).toMatchObject({
      isCompleted: true,
      isTerminal: true,
      progress: 1,
      output: { ok: 1 },
    });
    expect(deriveWorkflowView(wf('failed', { error: 'boom' })).error).toBe('boom');
  });
});

describe('createWorkflowPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls until terminal, reports isPolling transitions, and fires the callback once', async () => {
    const onCompleted = vi.fn();
    const responses = [wf('running'), wf('running', { completedSteps: 3 }), wf('completed')];
    const pollFn = vi.fn(async () => responses.shift() ?? null);
    const poller = createWorkflowPoller({ interval: 100, onCompleted });
    const polling: boolean[] = [];
    poller.subscribe((s) => polling.push(s.isPolling));

    poller.start(pollFn);
    expect(poller.get().isLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.get().isLoading).toBe(false);
    expect(poller.get().isPolling).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(deriveWorkflowView(poller.get().workflow).isCompleted).toBe(true);
    expect(poller.get().isPolling).toBe(false);
    expect(onCompleted).toHaveBeenCalledOnce();

    const calls = pollFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollFn.mock.calls.length).toBe(calls);
    // Transitions only — the store also notifies for isLoading/workflow changes.
    expect(polling.filter((v, i) => v !== (i === 0 ? false : polling[i - 1]))).toEqual([true, false]);
  });

  it('fires the terminal callback without polling when the first answer is already terminal', async () => {
    const onFailed = vi.fn();
    const poller = createWorkflowPoller({ interval: 100, onFailed });
    poller.start(async () => wf('failed', { error: 'boom' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(poller.get().isPolling).toBe(false);
  });

  it('keeps the last workflow when a poll answers null, and survives a throwing poll', async () => {
    const answers: Array<AiWorkflowData | null | Error> = [wf('running'), null, new Error('net'), wf('completed')];
    const poller = createWorkflowPoller({ interval: 100 });
    poller.start(async () => {
      const next = answers.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(poller.get().workflow?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(100);
    expect(poller.get().workflow?.status).toBe('completed');
  });

  it('stop halts polling and refresh is a no-op without a poll function', async () => {
    const pollFn = vi.fn(async () => wf('running'));
    const poller = createWorkflowPoller({ interval: 100 });
    poller.start(pollFn);
    await vi.advanceTimersByTimeAsync(150);
    poller.stop();
    const calls = pollFn.mock.calls.length;

    await poller.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollFn.mock.calls.length).toBe(calls);
    expect(poller.get().isLoading).toBe(false);
  });
});

describe('createWorkflowGuard', () => {
  it('rehydrates an active run into the poller and refuses a duplicate trigger', async () => {
    const poller = createWorkflowPoller({ interval: 1_000_000 });
    const guard = createWorkflowGuard(poller, {
      checkFn: async () => wf('running'),
      pollFn: async () => wf('running'),
    });
    expect(guard.get().isChecking).toBe(true);

    await guard.rehydrate();
    expect(guard.get().isChecking).toBe(false);
    expect(deriveWorkflowView(poller.get().workflow).isActive).toBe(true);

    const triggerFn = vi.fn(async () => {});
    expect(await guard.trigger(triggerFn)).toBe(false);
    expect(triggerFn).not.toHaveBeenCalled();
    poller.stop();
  });

  it('shows a terminal run without polling, and triggers when idle', async () => {
    const pollFn = vi.fn(async () => wf('running'));
    const poller = createWorkflowPoller({ interval: 1_000_000 });
    const guard = createWorkflowGuard(poller, { checkFn: async () => wf('completed'), pollFn });

    await guard.rehydrate();
    expect(poller.get().workflow?.status).toBe('completed');
    expect(pollFn).not.toHaveBeenCalled();

    expect(await guard.trigger(async () => {})).toBe(true);
    expect(pollFn).toHaveBeenCalled();
    expect(await guard.trigger(async () => { throw new Error('nope'); })).toBe(false);
    poller.stop();
  });
});

describe('createAiProgressStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tracks, polls while active, replaces state immutably, and signals the terminal transition', async () => {
    let status: 'running' | 'completed' = 'running';
    const onTerminal = vi.fn();
    const store = createAiProgressStore<{ id: number }>({
      fetchWorkflowStatus: async () => ({ status, totalSteps: 2, completedSteps: status === 'completed' ? 2 : 1 }),
      intervalMs: 100,
      onTerminal,
    });
    const snapshots: Array<ReturnType<typeof store.get>> = [];
    store.subscribe((s) => snapshots.push(s));

    store.track(7, 'demo', 'listing:1');
    store.track(7, 'demo', 'listing:1');
    expect(store.get().trackedWorkflows).toHaveLength(1);
    expect(hasActiveWorkflow(store.get())).toBe(true);

    const before = store.get();
    await vi.advanceTimersByTimeAsync(150);
    expect(store.get().trackedWorkflows[0]!.progress).toBe(50);
    expect(store.get()).not.toBe(before);
    expect(before.trackedWorkflows[0]!.progress).toBe(0); // the old snapshot was not mutated

    status = 'completed';
    await vi.advanceTimersByTimeAsync(100);
    expect(store.get().completionSignal).toBe(1);
    expect(hasActiveWorkflow(store.get())).toBe(false);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 7, status: 'completed' }));

    await vi.advanceTimersByTimeAsync(500);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('dismiss, markApplied, untrack and the derived selectors', () => {
    const store = createAiProgressStore<{ id: number }>({ fetchWorkflowStatus: async () => null });
    store.track(1, 'demo', 'listing:1');
    store.track(2, 'demo', 'listing:2');

    expect(trackedByEntityRef(store.get(), 'listing:1')?.workflowId).toBe(1);
    store.markApplied(1);
    expect(store.get().appliedSignal).toBe(1);
    expect(trackedByEntityRef(store.get(), 'listing:1')).toBeUndefined();
    expect(activeWorkflows(store.get()).map((w) => w.workflowId)).toEqual([2]);

    // Applied workflows stay tracked (dismissed) so a later probe knows they were handled; untrack removes.
    store.untrack(2);
    expect(store.get().trackedWorkflows.map((w) => [w.workflowId, w.dismissed])).toEqual([[1, true]]);

    store.openDialog({ id: 42 });
    expect(store.get().dialogRequest).toEqual({ id: 42 });
    store.reset();
    expect(store.get()).toEqual({ trackedWorkflows: [], completionSignal: 0, appliedSignal: 0, dialogRequest: null });
  });

  it('ignores a status that arrives for a workflow untracked mid-fetch', async () => {
    let resolve!: (v: { status: AiWorkflowStatus; totalSteps: number; completedSteps: number }) => void;
    const onTerminal = vi.fn();
    const store = createAiProgressStore<null>({
      fetchWorkflowStatus: () => new Promise((r) => (resolve = r)),
      intervalMs: 100,
      onTerminal,
    });
    store.track(3, 'demo', null);
    await vi.advanceTimersByTimeAsync(100);
    store.untrack(3);
    resolve({ status: 'completed', totalSteps: 1, completedSteps: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(onTerminal).not.toHaveBeenCalled();
    expect(store.get().completionSignal).toBe(0);
  });
});

describe('deriveAiCardState', () => {
  const tracked = (status: AiWorkflowStatus) => ({
    workflowId: 1, workflowType: 'demo', entityRef: 'e', status, progress: 0, totalSteps: 0, completedSteps: 0, dismissed: false,
  });

  it('local state beats the server answer; failures are surfaced for dismissal', () => {
    expect(deriveAiCardState({ tracked: tracked('running'), hasActiveWorkflow: false }).cardState).toBe('active');
    expect(deriveAiCardState({ tracked: tracked('failed') })).toMatchObject({ cardState: 'failed', failedWorkflow: { status: 'failed' } });
    expect(deriveAiCardState({ tracked: tracked('completed'), hasActiveWorkflow: true }).cardState).toBe('active');
    expect(deriveAiCardState({ tracked: undefined })).toEqual({ cardState: 'idle', failedWorkflow: null });
  });
});

describe('createActiveWorkflowProbe', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers for the current entity, polls while active, and stops when the answer turns false', async () => {
    let active = true;
    const fetchHasActive = vi.fn(async () => active);
    const probe = createActiveWorkflowProbe({ fetchHasActive, intervalMs: 100 });

    probe.setEntityRef('contact:1');
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.get().hasActive).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchHasActive).toHaveBeenCalledTimes(3);

    active = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(probe.get().hasActive).toBe(false);
    const calls = fetchHasActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchHasActive.mock.calls.length).toBe(calls);
  });

  it('does nothing without an entity, keeps the last answer on null, and swallows errors', async () => {
    const answers: Array<boolean | null | Error> = [true, null, new Error('net')];
    const fetchHasActive = vi.fn(async () => {
      const next = answers.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    });
    const probe = createActiveWorkflowProbe({ fetchHasActive, intervalMs: 100 });

    await probe.refresh();
    expect(fetchHasActive).not.toHaveBeenCalled();

    probe.setEntityRef('contact:1');
    await vi.advanceTimersByTimeAsync(250);
    expect(probe.get().hasActive).toBe(true);
    expect(probe.get().isChecking).toBe(false);
    probe.dispose();
  });

  it('discards an answer that belongs to a previous entity', async () => {
    const pending = new Map<string, (v: boolean) => void>();
    const probe = createActiveWorkflowProbe({
      fetchHasActive: (ref) => new Promise((r) => pending.set(ref, r)),
    });

    probe.setEntityRef('contact:1');
    probe.setEntityRef('contact:2');
    pending.get('contact:1')!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.get().hasActive).toBe(false);
    expect(probe.get().isChecking).toBe(true); // contact:2 is still being asked

    pending.get('contact:2')!(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.get().hasActive).toBe(true);
    probe.dispose();
  });
});
