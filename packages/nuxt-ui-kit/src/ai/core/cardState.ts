import type { TrackedWorkflow } from './progressStore.ts';
import { isActiveStatus } from './types.ts';

export type AiCardPhase = 'active' | 'failed' | 'idle';

export interface AiCardStateInput {
  /** The workflow tracked for the card's entity, if any (`trackedByEntityRef`). */
  tracked: TrackedWorkflow | undefined;
  /** The server's answer to "is something running?", for when the in-memory store cannot know. */
  hasActiveWorkflow?: boolean | undefined;
}

export interface AiCardState {
  cardState: AiCardPhase;
  /** The tracked workflow when it failed, for the card's dismissable error. */
  failedWorkflow: TrackedWorkflow | null;
}

/**
 * The state machine behind AI trigger/suggestion cards, as a pure function:
 * what is tracked locally beats what the server says, and a local failure is
 * shown until dismissed.
 */
export function deriveAiCardState(input: AiCardStateInput): AiCardState {
  const { tracked } = input;

  let cardState: AiCardPhase = 'idle';
  if (tracked && isActiveStatus(tracked.status)) cardState = 'active';
  else if (tracked?.status === 'failed') cardState = 'failed';
  else if (input.hasActiveWorkflow) cardState = 'active';

  return {
    cardState,
    failedWorkflow: tracked?.status === 'failed' ? tracked : null,
  };
}
