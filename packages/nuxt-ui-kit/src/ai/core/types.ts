export type AiWorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AiWorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface AiWorkflowStepData {
  id: number;
  key: string;
  type: string;
  status: AiWorkflowStepStatus;
  dependencies: string[];
  input?: unknown | null;
  output?: unknown | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AiWorkflowData<TOutput = unknown> {
  id: number;
  type: string;
  status: AiWorkflowStatus;
  input: unknown;
  output: TOutput | null;
  error: string | null;
  entityRef: string | null;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  steps: AiWorkflowStepData[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
}

const TERMINAL_STATUSES: AiWorkflowStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalStatus(status: AiWorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActiveStatus(status: AiWorkflowStatus): boolean {
  return status === 'pending' || status === 'running';
}
