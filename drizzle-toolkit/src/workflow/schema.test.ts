import { describe, it, expect } from 'vitest';
import { SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD } from './schema.ts';

describe('SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD', () => {
  it('parses a valid payload', () => {
    const payload = {
      tenantId: 'tenant-1',
      workflowId: 1,
      stepId: 2,
      stepKey: 'analyze-images',
      stepType: 'ai:analyze-images',
    };

    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(payload);
    }
  });

  it('accepts optional correlationId', () => {
    const payload = {
      tenantId: 'tenant-1',
      correlationId: 'req-123',
      workflowId: 1,
      stepId: 2,
      stepKey: 'step',
      stepType: 'handler',
    };

    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.correlationId).toBe('req-123');
    }
  });

  it('rejects missing tenantId', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      workflowId: 1,
      stepId: 2,
      stepKey: 'step',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty tenantId', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: '',
      workflowId: 1,
      stepId: 2,
      stepKey: 'step',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive workflowId', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: 'tenant-1',
      workflowId: 0,
      stepId: 2,
      stepKey: 'step',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer workflowId', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: 'tenant-1',
      workflowId: 1.5,
      stepId: 2,
      stepKey: 'step',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive stepId', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: 'tenant-1',
      workflowId: 1,
      stepId: -1,
      stepKey: 'step',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty stepKey', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: 'tenant-1',
      workflowId: 1,
      stepId: 2,
      stepKey: '',
      stepType: 'handler',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty stepType', () => {
    const result = SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD.safeParse({
      tenantId: 'tenant-1',
      workflowId: 1,
      stepId: 2,
      stepKey: 'step',
      stepType: '',
    });
    expect(result.success).toBe(false);
  });
});
