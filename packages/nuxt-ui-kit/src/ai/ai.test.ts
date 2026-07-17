import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { effectScope } from 'vue';
import type { AiWorkflowData } from './types.ts';
import { isTerminalStatus, isActiveStatus } from './types.ts';
import { useAiWorkflow } from './useAiWorkflow.ts';
import { createAiProgressCore } from './progressCore.ts';
import { useAiCardState } from './useAiCardState.ts';
import { createWorkflowRegistry } from './registry.ts';

const wf = (over: Partial<AiWorkflowData> = {}): AiWorkflowData => ({
  id: 1,
  type: 'demo',
  status: 'running',
  input: null,
  output: null,
  error: null,
  entityRef: 'listing:1',
  totalSteps: 4,
  completedSteps: 1,
  failedSteps: 0,
  steps: [],
  createdAt: '',
  startedAt: null,
  completedAt: null,
  appliedAt: null,
  ...over,
});

describe('status helpers', () => {
  it('classifies terminal vs active', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isActiveStatus('pending')).toBe(true);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
});

describe('useAiWorkflow', () => {
  it('polls until terminal and fires onCompleted', async () => {
    const scope = effectScope();
    const onCompleted = vi.fn();
    const responses = [wf(), wf({ completedSteps: 3 }), wf({ status: 'completed', completedSteps: 4, output: { ok: 1 } })];
    const pollFn = vi.fn(async () => responses.shift() ?? null);

    await scope.run(async () => {
      const ai = useAiWorkflow({ interval: 5, onCompleted });
      ai.start(pollFn);
      await vi.waitFor(() => expect(ai.isCompleted.value).toBe(true));
      expect(ai.output.value).toEqual({ ok: 1 });
      expect(ai.progress.value).toBe(1);
      expect(onCompleted).toHaveBeenCalledOnce();
      expect(ai.isPolling.value).toBe(false); // stopped at terminal

      // Polling stopped — no further calls
      const calls = pollFn.mock.calls.length;
      await new Promise((r) => setTimeout(r, 30));
      expect(pollFn.mock.calls.length).toBe(calls);
    });
    scope.stop();
  });

  it('fires onFailed and exposes the error', async () => {
    const scope = effectScope();
    const onFailed = vi.fn();
    await scope.run(async () => {
      const ai = useAiWorkflow({ interval: 5, onFailed });
      ai.start(async () => wf({ status: 'failed', error: 'boom' }));
      await vi.waitFor(() => expect(ai.isFailed.value).toBe(true));
      expect(ai.error.value).toBe('boom');
      expect(onFailed).toHaveBeenCalledOnce();
    });
    scope.stop();
  });
});

describe('createAiProgressCore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tracks, polls active workflows, and bumps completionSignal on terminal transition', async () => {
    let status: 'running' | 'completed' = 'running';
    const core = createAiProgressCore<{ id: number }>({
      fetchWorkflowStatus: async () => ({ status, totalSteps: 2, completedSteps: status === 'completed' ? 2 : 1 }),
      intervalMs: 100,
    });

    core.track(7, 'demo', 'listing:1');
    expect(core.hasActive.value).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(core.trackedWorkflows.value[0]!.progress).toBe(50);

    status = 'completed';
    await vi.advanceTimersByTimeAsync(100);
    expect(core.completionSignal.value).toBe(1);
    expect(core.hasActive.value).toBe(false);
  });

  it('fires onTerminal once per workflow with the tracked entry', async () => {
    let status: 'running' | 'completed' = 'running';
    const onTerminal = vi.fn();
    const core = createAiProgressCore<{ id: number }>({
      fetchWorkflowStatus: async () => ({ status, totalSteps: 2, completedSteps: status === 'completed' ? 2 : 1 }),
      intervalMs: 100,
      onTerminal,
    });

    core.track(7, 'demo', 'listing:1');
    await vi.advanceTimersByTimeAsync(150);
    expect(onTerminal).not.toHaveBeenCalled();

    status = 'completed';
    await vi.advanceTimersByTimeAsync(100);
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 7, workflowType: 'demo', status: 'completed' }),
    );

    // Terminal workflows leave the poll set — no repeat notification.
    await vi.advanceTimersByTimeAsync(300);
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it('deduplicates track calls and supports dismiss/markApplied/getByEntityRef', () => {
    const core = createAiProgressCore<{ id: number }>({ fetchWorkflowStatus: async () => null });
    core.track(1, 'demo', 'listing:1');
    core.track(1, 'demo', 'listing:1');
    expect(core.trackedWorkflows.value).toHaveLength(1);
    expect(core.getByEntityRef('listing:1')?.workflowId).toBe(1);

    core.markApplied(1);
    expect(core.appliedSignal.value).toBe(1);
    expect(core.getByEntityRef('listing:1')).toBeUndefined();
    expect(core.activeWorkflows.value).toHaveLength(0);
  });

  it('carries dialog requests through open/close', () => {
    const core = createAiProgressCore<{ id: number }>({ fetchWorkflowStatus: async () => null });
    core.openDialog({ id: 42 });
    expect(core.dialogRequest.value).toEqual({ id: 42 });
    core.closeDialog();
    expect(core.dialogRequest.value).toBeNull();
  });
});

describe('useAiCardState', () => {
  it('derives active/failed/idle from the injected store slice', () => {
    const tracked = { workflowId: 9, workflowType: 'demo', entityRef: 'x', status: 'failed', progress: 0, totalSteps: 0, completedSteps: 0, dismissed: false } as const;
    const dismiss = vi.fn();
    const state = useAiCardState(
      { getByEntityRef: (r) => (r === 'x' ? { ...tracked } : undefined), dismiss },
      'x',
    );
    expect(state.cardState.value).toBe('failed');
    state.dismissFailure();
    expect(dismiss).toHaveBeenCalledWith(9);

    const idle = useAiCardState({ getByEntityRef: () => undefined, dismiss }, 'y');
    expect(idle.cardState.value).toBe('idle');

    const external = useAiCardState({ getByEntityRef: () => undefined, dismiss }, 'y', () => true);
    expect(external.cardState.value).toBe('active');
  });
});

describe('createWorkflowRegistry', () => {
  it('registers, fetches, lists, and resolves labels with fallbacks', () => {
    const reg = createWorkflowRegistry<{ type: string; labelKey: string; icon: string }>({
      extraLabelKeys: { 'embedding:sync': 'usage.embedding' },
    });
    reg.register({ type: 'demo', labelKey: 'ai.demo', icon: 'i' });

    const t = (k: string) => `T(${k})`;
    expect(reg.get('demo')?.icon).toBe('i');
    expect(reg.getAll()).toHaveLength(1);
    expect(reg.getLabel('demo', t)).toBe('T(ai.demo)');
    expect(reg.getLabel('embedding:sync', t)).toBe('T(usage.embedding)');
    expect(reg.getLabel('unknown', t)).toBe('unknown');
  });
});
