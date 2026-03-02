import { z } from 'zod';
import { SCHEMA_BASE_JOB_PAYLOAD } from './queue';

/**
 * Payload for workflow-step queue jobs.
 * Each job represents a single step within a multi-step workflow.
 */
export const SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD = SCHEMA_BASE_JOB_PAYLOAD.extend({
  workflowId: z.number().int().positive(),
  stepId: z.number().int().positive(),
  stepKey: z.string().min(1),
  stepType: z.string().min(1),
});

export type WorkflowStepJobPayload = z.infer<typeof SCHEMA_WORKFLOW_STEP_JOB_PAYLOAD>;
