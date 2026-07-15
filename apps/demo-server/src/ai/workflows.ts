/**
 * The demo's AI workflow — `contact-brief` (`@octabits-io/flow/ai`).
 *
 * A three-step DAG over one contact: `fetch` loads the row through the host's
 * services, then `summarize` and `followup` both depend on it and therefore run
 * in parallel — the engine derives that from the dependency graph, nothing is
 * scheduled by hand. The workflow's final output is the aggregate
 * `{ fetch, summarize, followup }`, one key per step.
 *
 * `defineAiStep` is flow-core's `defineStep` with the context fixed to
 * `AiContext<AiHost>`: handlers get `ctx.context.model` (already instrumented —
 * token usage is captured without the handler doing anything) and
 * `ctx.context.host` (whatever the hooks' `resolveHost` returns; here a bundle
 * of root-container singletons, so there is no per-step scope to dispose).
 * `fetch` is an "AI step" that never touches the model — mixing model and
 * non-model steps in one AI workflow is normal.
 */
import { z } from 'zod';
import { generateText } from 'ai';
import type { TypedWorkflow } from '@octabits-io/flow';
import { defineAiStep, buildAiWorkflow, type AiContext } from '@octabits-io/flow/ai';
import type { Logger } from '@octabits-io/framework/logger';
import type { ContactsService } from '../services/contacts.ts';

/** What AI step handlers may reach — root singletons only, nothing to dispose. */
export interface AiHost {
  contactsService: ContactsService;
  logger: Logger;
}

export const CONTACT_BRIEF_TYPE = 'contact-brief';

const SCHEMA_CONTACT_BRIEF_INPUT = z.object({ contactId: z.uuid() });
export type ContactBriefInput = z.infer<typeof SCHEMA_CONTACT_BRIEF_INPUT>;

const fetch = defineAiStep<ContactBriefInput, { name: string; email: string }, AiHost>({
  type: 'contact-brief.fetch',
  workflowInputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  outputSchema: z.object({ name: z.string(), email: z.string() }),
  handler: async (ctx) => {
    const contact = await ctx.context.host.contactsService.getById(ctx.workflowInput.contactId);
    // Expected errors are Results everywhere else in this app, but a flow step
    // handler signals failure by throwing — the engine owns retry/DLQ policy,
    // and a missing contact is permanent, so no retry policy is set on this step.
    if (!contact.ok) throw new Error(contact.error.message);
    return { name: contact.value.name, email: contact.value.email };
  },
});

// The THost generic is explicit on the dependent steps: inference would have to
// derive it from `dependencies`, but the `THost = unknown` default wins first.
const summarize = defineAiStep<ContactBriefInput, { summary: string }, AiHost, { fetch: typeof fetch }>({
  type: 'contact-brief.summarize',
  workflowInputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  outputSchema: z.object({ summary: z.string() }),
  dependencies: { fetch },
  retry: { maxAttempts: 3 },
  handler: async (ctx) => {
    const { text } = await generateText({
      model: ctx.context.model,
      prompt: `[summarize] Summarize this contact for a colleague in one sentence.\nName: ${ctx.deps.fetch.name}\nEmail: ${ctx.deps.fetch.email}`,
    });
    return { summary: text };
  },
});

const followup = defineAiStep<ContactBriefInput, { draft: string }, AiHost, { fetch: typeof fetch }>({
  type: 'contact-brief.followup',
  workflowInputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  outputSchema: z.object({ draft: z.string() }),
  dependencies: { fetch },
  retry: { maxAttempts: 3 },
  handler: async (ctx) => {
    const { text } = await generateText({
      model: ctx.context.model,
      prompt: `[follow-up] Draft a short, friendly follow-up email.\nName: ${ctx.deps.fetch.name}\nEmail: ${ctx.deps.fetch.email}`,
    });
    return { draft: text };
  },
});

export const contactBriefWorkflow = buildAiWorkflow<ContactBriefInput, AiHost>({
  type: CONTACT_BRIEF_TYPE,
  inputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  steps: { fetch, summarize, followup },
});

/** The final workflow output (flow aggregates `{ [stepKey]: stepOutput }`). */
export interface ContactBriefOutput {
  fetch: { name: string; email: string };
  summarize: { summary: string };
  followup: { draft: string };
}

/** Every AI workflow this app ships, by type — start-route dispatch table. */
export const aiWorkflowsByType: Record<string, TypedWorkflow<ContactBriefInput, AiContext<AiHost>>> = {
  [CONTACT_BRIEF_TYPE]: contactBriefWorkflow,
};
