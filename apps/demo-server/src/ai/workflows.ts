/**
 * The demo's AI workflow — `contact-brief` (`octaflow/ai`).
 *
 * A four-step DAG over one contact: `fetch` loads the row through the host's
 * services, then `summarize` and `followup` both depend on it and therefore run
 * in parallel — the engine derives that from the dependency graph, nothing is
 * scheduled by hand. `propose` depends on all three and turns what the model
 * produced into a **proposal** (`@octabits-io/framework/proposal`): an update
 * to the contact's `brief` that says what it replaces, and a follow-up note to
 * create. The workflow's final output is the aggregate
 * `{ fetch, summarize, followup, propose }`, one key per step, and
 * `output.propose` is what the review card renders and the apply route commits.
 *
 * `defineAiStep` is flow-core's `defineStep` with the context fixed to
 * `AiContext<AiHost>`: handlers get `ctx.context.model` (already instrumented —
 * token usage is captured without the handler doing anything) and
 * `ctx.context.host` (whatever the hooks' `resolveHost` returns; here a bundle
 * of root-container singletons, so there is no per-step scope to dispose).
 * `fetch` and `propose` are "AI steps" that never touch the model — mixing
 * model and non-model steps in one AI workflow is normal.
 *
 * Why `propose` is its own step rather than a projection in the route: the
 * proposal captures `current` — what the contact's brief holds at the moment
 * the run finishes — and stores it in the run's own output. That makes the diff
 * a fact about the run, persisted with it, rather than something the browser
 * re-derives by reading the contact again later. It also makes the proposal
 * the step's **output schema**, which is the contract's rule for staying
 * composable: a step whose internals were a tool loop would emit the same shape.
 */
import { z } from 'zod';
import { generateText } from 'ai';
import type { TypedWorkflow } from 'octaflow';
import { defineAiStep, buildAiWorkflow, type AiContext } from 'octaflow/ai';
import type { Logger } from '@octabits-io/framework/logger';
import {
  buildProposal,
  driftDigest,
  entityAnchor,
  proposalSchema,
  proposeCreate,
  proposeFields,
  SKIP_REASONS,
} from '@octabits-io/framework/proposal';
import type { Proposal, SkippedItem } from '@octabits-io/framework/proposal';
import type { ContactsService } from '../services/contacts.ts';
import { DEMO_MODEL_ID } from './model.ts';

/**
 * `Proposal` as a step output. flow constrains step outputs to
 * `Record<string, unknown>`, which an interface does not satisfy structurally
 * (no index signature); the mapped alias is the same shape and does.
 */
type ProposalOutput = { [K in keyof Proposal]: Proposal[K] };

/** What AI step handlers may reach — root singletons only, nothing to dispose. */
export interface AiHost {
  contactsService: ContactsService;
  logger: Logger;
}

export const CONTACT_BRIEF_TYPE = 'contact-brief';

/** The proposal's addressing vocabulary — what the apply side maps back to tables. */
export const PROPOSAL_TARGETS = {
  /** `update` target type; the contact row. */
  contact: 'contact',
  /** The one contact field the workflow writes. */
  briefPath: 'brief',
  /** `create` collection; the follow-up note. */
  notes: 'notes',
} as const;

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

/**
 * The producer — layer 3 of the review kit, the part a host writes:
 * structured model output → operations against rows the host already has.
 *
 * Two things happen here that a route cannot do later. `current` is read
 * from the contact *now* and stored beside the proposed value, so the review
 * shows what applying would overwrite as of the run, not as of the page load.
 * And the update carries a `guard`, the digest of that `current`, which the
 * apply route recomputes against the live row — if someone edited the brief
 * in between, the apply refuses rather than silently overwriting their work.
 *
 * The follow-up is a `create` whose value is the note *body*: the reviewer
 * edits the text, and the host supplies the title at apply time from what it
 * knows (the contact's name). A create's value is one JSON value, so a row
 * with several reviewer-editable fields would show as JSON in the generic card
 * today — field-level editing of creates is the contract's next gap.
 */
const propose = defineAiStep<
  ContactBriefInput,
  ProposalOutput,
  AiHost,
  { fetch: typeof fetch; summarize: typeof summarize; followup: typeof followup }
>({
  type: 'contact-brief.propose',
  workflowInputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  // The proposal IS the step's output schema — validated on the way out, like
  // any other step output, and readable from the run's stored output.
  outputSchema: proposalSchema as unknown as z.ZodType<ProposalOutput>,
  dependencies: { fetch, summarize, followup },
  handler: async (ctx) => {
    const { contactId } = ctx.workflowInput;
    // Re-read rather than reuse `fetch`'s output: `current` must be what the
    // slot holds when the proposal is emitted, and the model steps took time.
    const contact = await ctx.context.host.contactsService.getById(contactId);
    if (!contact.ok) throw new Error(contact.error.message);

    const target = entityAnchor(PROPOSAL_TARGETS.contact, contactId, contact.value.name);
    const current = contact.value.brief;
    const summary = ctx.deps.summarize.summary.trim();
    const draft = ctx.deps.followup.draft.trim();

    const skipped: SkippedItem[] = [];
    if (!summary) skipped.push({ target, path: [PROPOSAL_TARGETS.briefPath], reason: SKIP_REASONS.noOutput });
    if (!draft) skipped.push({ reason: SKIP_REASONS.noOutput, detail: 'The follow-up draft came back empty.' });

    return buildProposal({
      scope: `contact:${contactId}`,
      workflowId: ctx.workflowId,
      workflowType: CONTACT_BRIEF_TYPE,
      operations: [
        // Drops the update if the model reproduced the stored brief verbatim.
        ...proposeFields({
          target,
          current: { [PROPOSAL_TARGETS.briefPath]: current },
          proposed: { [PROPOSAL_TARGETS.briefPath]: summary || undefined },
          guard: { [PROPOSAL_TARGETS.briefPath]: driftDigest(current) },
          display: {
            [PROPOSAL_TARGETS.briefPath]: { labelKey: 'ai.brief.fields.brief', control: 'multiline', maxLength: 2000, order: 1 },
          },
        }),
        ...(draft
          ? [
              proposeCreate({
                collection: PROPOSAL_TARGETS.notes,
                ref: 'followup',
                value: draft,
                display: { labelKey: 'ai.brief.fields.followup', control: 'multiline', maxLength: 10_000, order: 2 },
              }),
            ]
          : []),
      ],
      skipped,
      provenance: {
        model: DEMO_MODEL_ID,
        // Single-scope demo: the platform key paid (engine.ts resolves the same).
        keySource: 'platform',
        generatedAt: new Date().toISOString(),
      },
    });
  },
});

export const contactBriefWorkflow = buildAiWorkflow<ContactBriefInput, AiHost>({
  type: CONTACT_BRIEF_TYPE,
  inputSchema: SCHEMA_CONTACT_BRIEF_INPUT,
  steps: { fetch, summarize, followup, propose },
});

/** The final workflow output (flow aggregates `{ [stepKey]: stepOutput }`). */
export interface ContactBriefOutput {
  fetch: { name: string; email: string };
  summarize: { summary: string };
  followup: { draft: string };
  propose: Proposal;
}

/** Every AI workflow this app ships, by type — start-route dispatch table. */
export const aiWorkflowsByType: Record<string, TypedWorkflow<ContactBriefInput, AiContext<AiHost>>> = {
  [CONTACT_BRIEF_TYPE]: contactBriefWorkflow,
};
