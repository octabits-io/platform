import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ok } from '@octabits-io/foundation/result';
import { defineStep, buildTypedWorkflow, isRetryableError } from './define-step.ts';
import { createStepHandlerRegistry } from './step-handler-registry.ts';
import type { StepExecutionContext } from './types.ts';

// ============================================================================
// isRetryableError
// ============================================================================

describe('isRetryableError', () => {
  it('returns false for non-Error values', () => {
    expect(isRetryableError('string error')).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('detects rate limit errors', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRetryableError(new Error('too many requests'))).toBe(true);
  });

  it('detects network/timeout errors', () => {
    expect(isRetryableError(new Error('request timeout'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('detects service unavailable errors', () => {
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryableError(new Error('service unavailable'))).toBe(true);
  });

  it('returns false for generic errors', () => {
    expect(isRetryableError(new Error('validation failed'))).toBe(false);
    expect(isRetryableError(new Error('not found'))).toBe(false);
    expect(isRetryableError(new Error('unauthorized'))).toBe(false);
  });
});

// ============================================================================
// defineStep
// ============================================================================

const inputSchema = z.object({ url: z.string() });
const outputSchema = z.object({ result: z.string() });

describe('defineStep', () => {
  it('creates a TypedStep with correct metadata', () => {
    const step = defineStep({
      type: 'fetch-url',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => ({ result: 'done' }),
    });

    expect(step.type).toBe('fetch-url');
    expect(step.workflowInputSchema).toBe(inputSchema);
    expect(step.outputSchema).toBe(outputSchema);
    expect(step.dependencies).toEqual({});
    expect(typeof step.handler).toBe('function');
  });

  it('wraps handler and validates workflow input (phase 1)', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => ({ result: 'done' }),
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 123 }, // invalid: url should be string
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid workflow input');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('validates dependency outputs (phase 2)', async () => {
    const depOutputSchema = z.object({ count: z.number() });
    const depStep = defineStep({
      type: 'dep-step',
      workflowInputSchema: inputSchema,
      outputSchema: depOutputSchema,
      handler: async () => ({ count: 42 }),
    });

    const step = defineStep({
      type: 'consumer',
      workflowInputSchema: inputSchema,
      outputSchema,
      dependencies: { dep: depStep },
      handler: async () => ({ result: 'done' }),
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 2,
      stepKey: 'consumer',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: { dep: { count: 'not-a-number' } }, // invalid
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid dependency output 'dep'");
      expect(result.error.retryable).toBe(false);
    }
  });

  it('validates handler output (phase 5)', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => ({ wrong: 'field' } as any),
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Invalid step output');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('returns successful result when all phases pass', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async (ctx) => ({ result: `fetched ${ctx.workflowInput.url}` }),
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result).toEqual({ ok: true, value: { result: 'fetched https://example.com' } });
  });

  it('catches handler throws and marks as retryable based on error type', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => {
        throw new Error('rate limit exceeded');
      },
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe('rate limit exceeded');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('marks non-retryable errors as such', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => {
        throw new Error('validation failed');
      },
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  it('accepts a custom isRetryableError function', async () => {
    const step = defineStep({
      type: 'test',
      workflowInputSchema: inputSchema,
      outputSchema,
      handler: async () => {
        throw new Error('custom retryable');
      },
      isRetryableError: () => true, // always retryable
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 1,
      stepKey: 'test',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: {},
    };

    const result = await step.handler(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  it('passes parsed dependency outputs to handler', async () => {
    const depOutputSchema = z.object({ count: z.number() });
    const depStep = defineStep({
      type: 'dep',
      workflowInputSchema: inputSchema,
      outputSchema: depOutputSchema,
      handler: async () => ({ count: 42 }),
    });

    let receivedDeps: any = null;
    const step = defineStep({
      type: 'consumer',
      workflowInputSchema: inputSchema,
      outputSchema,
      dependencies: { dep: depStep },
      handler: async (ctx) => {
        receivedDeps = ctx.deps;
        return { result: 'done' };
      },
    });

    const ctx: StepExecutionContext = {
      workflowId: 1,
      stepId: 2,
      stepKey: 'consumer',
      tenantId: 'tenant-1',
      workflowInput: { url: 'https://example.com' },
      stepInput: {},
      dependencyOutputs: { dep: { count: 42 } },
    };

    await step.handler(ctx);
    expect(receivedDeps).toEqual({ dep: { count: 42 } });
  });
});

// ============================================================================
// buildTypedWorkflow
// ============================================================================

describe('buildTypedWorkflow', () => {
  const wfInputSchema = z.object({ targetUrl: z.string() });

  it('derives WorkflowDefinition from step metadata', () => {
    const stepA = defineStep({
      type: 'type-a',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ a: z.string() }),
      handler: async () => ({ a: 'result-a' }),
    });

    const stepB = defineStep({
      type: 'type-b',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ b: z.string() }),
      dependencies: { stepA },
      handler: async () => ({ b: 'result-b' }),
    });

    const workflow = buildTypedWorkflow({
      type: 'test-workflow',
      inputSchema: wfInputSchema,
      steps: { stepA, stepB },
    });

    expect(workflow.type).toBe('test-workflow');
    expect(workflow.definition).toEqual({
      type: 'test-workflow',
      steps: [
        { key: 'stepA', type: 'type-a' },
        { key: 'stepB', type: 'type-b', dependencies: ['stepA'] },
      ],
    });
  });

  it('throws at construction time for invalid dependency references', () => {
    const stepA = defineStep({
      type: 'type-a',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ a: z.string() }),
      dependencies: { nonExistent: { type: 'fake', dependencies: {}, outputSchema: z.object({}), workflowInputSchema: z.object({}), handler: async () => ({ ok: true, value: {} }) } } as any,
      handler: async () => ({ a: 'result' }),
    });

    expect(() =>
      buildTypedWorkflow({
        type: 'bad-workflow',
        inputSchema: wfInputSchema,
        steps: { stepA },
      }),
    ).toThrow("depends on 'nonExistent', which is not a valid step key");
  });

  it('registers all step handlers with the registry', () => {
    const stepA = defineStep({
      type: 'type-a',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ a: z.string() }),
      handler: async () => ({ a: 'done' }),
    });

    const workflow = buildTypedWorkflow({
      type: 'test',
      inputSchema: wfInputSchema,
      steps: { stepA },
    });

    const registry = createStepHandlerRegistry();
    workflow.register(registry);

    expect(registry.has('type-a')).toBe(true);
    expect(registry.types()).toEqual(['type-a']);
  });

  it('start() validates input and calls engine.startWorkflow', async () => {
    const stepA = defineStep({
      type: 'type-a',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ a: z.string() }),
      handler: async () => ({ a: 'done' }),
    });

    const workflow = buildTypedWorkflow({
      type: 'test',
      inputSchema: wfInputSchema,
      steps: { stepA },
    });

    let receivedDefinition: any = null;
    let receivedInput: any = null;
    const mockEngine = {
      startWorkflow: async (def: any, input: any) => {
        receivedDefinition = def;
        receivedInput = input;
        return ok({ workflowId: 1, totalSteps: 1, enqueuedSteps: ['stepA'] });
      },
    } as any;

    const result = await workflow.start(mockEngine, { targetUrl: 'https://example.com' });

    expect(result.ok).toBe(true);
    expect(receivedDefinition).toEqual(workflow.definition);
    expect(receivedInput).toEqual({ targetUrl: 'https://example.com' });
  });

  it('start() throws on invalid input', async () => {
    const stepA = defineStep({
      type: 'type-a',
      workflowInputSchema: wfInputSchema,
      outputSchema: z.object({ a: z.string() }),
      handler: async () => ({ a: 'done' }),
    });

    const workflow = buildTypedWorkflow({
      type: 'test',
      inputSchema: wfInputSchema,
      steps: { stepA },
    });

    const mockEngine = { startWorkflow: async () => ({ ok: true, value: {} }) } as any;

    expect(() =>
      workflow.start(mockEngine, { targetUrl: 123 } as any),
    ).toThrow();
  });
});
