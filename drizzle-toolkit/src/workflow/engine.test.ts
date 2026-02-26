import { describe, it, expect } from 'vitest';
import { ok } from '@octabits-io/foundation/result';
import { createWorkflowEngine } from './engine.ts';
import { createStepHandlerRegistry } from './step-handler-registry.ts';
import type { StepHandler } from './types.ts';

const noopHandler: StepHandler = async () => ok({});

/**
 * Creates a minimal engine instance suitable for testing validateDefinition.
 * DB-dependent methods are not exercised in these tests.
 */
function createTestEngine(registeredTypes: string[] = []) {
  const registry = createStepHandlerRegistry();
  for (const type of registeredTypes) {
    registry.register(type, noopHandler);
  }

  return createWorkflowEngine({
    db: {} as any,
    tables: { workflow: {} as any, workflowStep: {} as any },
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any,
    stepHandlerRegistry: registry,
    enqueueStepJob: async () => ok({ jobId: '1', queue: 'test' }),
    tenantId: 'tenant-1',
  });
}

describe('validateDefinition', () => {
  it('rejects empty steps', () => {
    const engine = createTestEngine();
    const result = engine.validateDefinition({ type: 'test', steps: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('invalid_workflow_definition_error');
      expect(result.error.message).toContain('at least one step');
    }
  });

  it('rejects duplicate step keys', () => {
    const engine = createTestEngine(['handler-a']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 'step-a', type: 'handler-a' },
        { key: 'step-a', type: 'handler-a' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Duplicate step key: step-a');
    }
  });

  it('rejects unknown dependency references', () => {
    const engine = createTestEngine(['handler-a']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 'step-a', type: 'handler-a', dependencies: ['nonexistent'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("depends on unknown step 'nonexistent'");
    }
  });

  it('rejects self-dependency', () => {
    const engine = createTestEngine(['handler-a']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 'step-a', type: 'handler-a', dependencies: ['step-a'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('cannot depend on itself');
    }
  });

  it('detects circular dependencies', () => {
    const engine = createTestEngine(['handler-a', 'handler-b']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 'step-a', type: 'handler-a', dependencies: ['step-b'] },
        { key: 'step-b', type: 'handler-b', dependencies: ['step-a'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('circular dependencies');
    }
  });

  it('detects missing step handlers', () => {
    const engine = createTestEngine([]); // no handlers registered
    const result = engine.validateDefinition({
      type: 'test',
      steps: [{ key: 'step-a', type: 'unregistered-handler' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('step_handler_not_found');
      expect(result.error.message).toContain('unregistered-handler');
    }
  });

  it('accepts a valid linear workflow', () => {
    const engine = createTestEngine(['handler-a', 'handler-b', 'handler-c']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 'step-a', type: 'handler-a' },
        { key: 'step-b', type: 'handler-b', dependencies: ['step-a'] },
        { key: 'step-c', type: 'handler-c', dependencies: ['step-b'] },
      ],
    });
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('accepts a valid DAG with parallel branches', () => {
    const engine = createTestEngine(['fetch', 'analyze', 'optimize', 'merge']);
    const result = engine.validateDefinition({
      type: 'enrichment',
      steps: [
        { key: 'fetch', type: 'fetch' },
        { key: 'analyze', type: 'analyze', dependencies: ['fetch'] },
        { key: 'optimize', type: 'optimize', dependencies: ['fetch'] },
        { key: 'merge', type: 'merge', dependencies: ['analyze', 'optimize'] },
      ],
    });
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('accepts steps with no dependencies (all parallel)', () => {
    const engine = createTestEngine(['a', 'b', 'c']);
    const result = engine.validateDefinition({
      type: 'parallel',
      steps: [
        { key: 's1', type: 'a' },
        { key: 's2', type: 'b' },
        { key: 's3', type: 'c' },
      ],
    });
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('detects 3-node cycle', () => {
    const engine = createTestEngine(['a', 'b', 'c']);
    const result = engine.validateDefinition({
      type: 'test',
      steps: [
        { key: 's1', type: 'a', dependencies: ['s3'] },
        { key: 's2', type: 'b', dependencies: ['s1'] },
        { key: 's3', type: 'c', dependencies: ['s2'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('circular dependencies');
    }
  });
});
