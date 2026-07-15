/**
 * The app-owned AI workflow registry (`createWorkflowRegistry`).
 *
 * The kit deliberately owns only registration + label lookup; the definition
 * shape is the app's. This demo's definitions carry the trigger context the
 * contact-brief modal needs (which server workflow `type` to POST) plus the
 * i18n label key.
 */
import { createWorkflowRegistry } from '@octabits-io/nuxt-ui-kit/ai'

export interface AiWorkflowDefinition {
  /** Server-side workflow type (`@octabits-io/flow`'s `WorkflowDefinition.type`). */
  type: string
  labelKey: string
}

export const CONTACT_BRIEF: AiWorkflowDefinition = {
  type: 'contact-brief',
  labelKey: 'ai.workflows.contactBrief',
}

export const aiWorkflowRegistry = createWorkflowRegistry<AiWorkflowDefinition>()
aiWorkflowRegistry.register(CONTACT_BRIEF)

/** The output shape of the contact-brief workflow (one key per DAG step). */
export interface ContactBriefOutput {
  fetch: { name: string; email: string }
  summarize: { summary: string }
  followup: { draft: string }
}
