/**
 * Applying and reverting a proposal — the host's half of the review loop.
 *
 * `@octabits-io/framework/proposal` deliberately does not write anything: it
 * knows operations, not tables. What a host owns is exactly what this file is:
 *
 *   1. **Where the proposal lives.** Here it is the `propose` step's output on
 *      the completed workflow (`loadProposal`), read through the engine.
 *   2. **The mapping from anchors to rows.** `applyOperation` is a switch on
 *      `target.type` / `collection` / `path` — the only place that knows a
 *      `contact` update on `brief` is `contactsService.update`, and a `notes`
 *      create is a note whose title the host supplies.
 *   3. **The drift check.** `detectDrift` over the live row, with the same
 *      `driftDigest` the producer used. A guard mismatch is a 409, not a
 *      silent overwrite.
 *   4. **The ledger row.** One `agent_ledger` row per application
 *      (`…/drizzle/agent-ledger`): the principal — the agent, on whose behalf,
 *      under which grant — the mode, the decision, the operations as written,
 *      the ids this host assigned to creates, and the reversibility class.
 *      That row is what `appliedAt` on the wire is projected from, and what
 *      revert reads — a revert never re-reads the entity to guess "before".
 *   5. **Revert as a second application.** `invertOperations` turns the ledger
 *      row into the operations that undo it, and they go through the same
 *      `applyOperation`. Irreversible operations are named, not undone.
 *
 * What a production host adds and this demo does not: one transaction around
 * the writes (these services take no `tx`), a real principal with a grant
 * record (the demo has a role header, so `onBehalfOf` is that and
 * `authorizationId` is absent), and per-scope routing of the engine.
 */
import { ok, err } from '@octabits-io/framework/result';
import type { OctError, Result } from '@octabits-io/framework/result';
import type { DateProvider } from '@octabits-io/framework/utils';
import type { DrizzleAgentLedgerStore } from '@octabits-io/framework/drizzle/agent-ledger';
import {
  detectDrift,
  invertOperations,
  parseEntityRef,
  proposalSchema,
  resolveDecision,
  reversibilityOf,
  validateProposal,
} from '@octabits-io/framework/proposal';
import type {
  Principal,
  Proposal,
  ProposalDecision,
  ProposedOperation,
  ResolvedOperation,
} from '@octabits-io/framework/proposal';
import type { Contact, ContactsService } from '../services/contacts.ts';
import type { NotesService } from '../services/notes.ts';
import type { DemoAiEngine } from './engine.ts';
import { CONTACT_BRIEF_AGENT, PROPOSAL_TARGETS } from './workflows.ts';

export interface ProposalServiceDeps {
  engine: Pick<DemoAiEngine, 'getWorkflowStatus'>;
  contacts: Pick<ContactsService, 'getById' | 'update'>;
  notes: Pick<NotesService, 'create' | 'delete'>;
  ledger: DrizzleAgentLedgerStore;
  dateProvider: DateProvider;
}

export interface ApplyResult {
  appliedAt: string;
  /** Ids assigned to creates, by `ref` — the SPA can link to what was made. */
  created: Record<string, string>;
}

export interface RevertResult {
  revertedAt: string;
  /** Creates that could not be undone because no id was recorded for them. */
  missing: string[];
  /** Operations that were declared irreversible and therefore left in place. */
  irreversible: string[];
  /** Operations undone by a correction rather than a clean reversal. */
  compensable: string[];
}

const failure = (key: string, message: string): OctError => ({ key, message });

export function createProposalService({ engine, contacts, notes, ledger, dateProvider }: ProposalServiceDeps) {
  /** The proposal a completed run stored as its `propose` step output. */
  async function loadProposal(workflowId: number): Promise<Result<Proposal, OctError>> {
    const workflow = await engine.getWorkflowStatus(workflowId);
    if (!workflow.ok) return workflow;
    if (workflow.value.status !== 'completed') {
      return err(
        failure('proposal_not_found', `Workflow ${workflowId} has no proposal until it completes (status: ${workflow.value.status})`),
      );
    }
    const parsed = proposalSchema.safeParse(workflow.value.output?.propose);
    if (!parsed.success) return err(failure('proposal_not_found', `Workflow ${workflowId} produced no proposal`));
    return ok(parsed.data as Proposal);
  }

  /** The contact a proposal is about, from its `scope` (`contact:<id>`). */
  async function contactOf(scope: string): Promise<Result<Contact, OctError>> {
    const ref = parseEntityRef(scope);
    if (!ref || ref.type !== PROPOSAL_TARGETS.contact) {
      return err(failure('proposal_invalid', `Scope '${scope}' is not a contact`));
    }
    return contacts.getById(ref.id);
  }

  /** The agent as the acting principal, delegated by whoever pressed Apply. */
  const actingAs = (onBehalfOf: string | null): Principal => ({
    ...CONTACT_BRIEF_AGENT,
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });

  const isBriefUpdate = (op: ProposedOperation) =>
    op.op === 'update'
    && op.target.kind === 'entity'
    && op.target.type === PROPOSAL_TARGETS.contact
    && op.path.length === 1
    && op.path[0] === PROPOSAL_TARGETS.briefPath;

  /**
   * One operation → one write. The only place that knows which table an
   * anchor names. Returns the id it assigned when it created something.
   */
  async function applyOperation(
    op: ProposedOperation,
    contact: Contact,
  ): Promise<Result<{ ref: string; id: string } | undefined, OctError>> {
    if (op.op === 'update' && isBriefUpdate(op)) {
      const value = op.proposed;
      if (value !== null && typeof value !== 'string') {
        return err(failure('proposal_unsupported_operation', `Operation ${op.id}: a brief must be text or null`));
      }
      const updated = await contacts.update(contact.id, { brief: value });
      return updated.ok ? ok(undefined) : updated;
    }

    if (op.op === 'create' && op.collection === PROPOSAL_TARGETS.notes) {
      if (typeof op.value !== 'string') {
        return err(failure('proposal_unsupported_operation', `Operation ${op.id}: a note body must be text`));
      }
      const id = crypto.randomUUID();
      const created = await notes.create({
        id,
        title: `Follow-up: ${contact.name}`,
        body: op.value,
        publicTitle: {},
        publicBody: {},
      });
      return created.ok ? ok({ ref: op.ref, id }) : created;
    }

    if (op.op === 'delete' && op.target.kind === 'entity' && op.target.type === PROPOSAL_TARGETS.notes) {
      const deleted = await notes.delete({ id: op.target.id });
      return deleted.ok ? ok(undefined) : deleted;
    }

    return err(failure('proposal_unsupported_operation', `Operation ${op.id} (${op.op}) is not something this host applies`));
  }

  /**
   * Commit a reviewer's decision. Refuses a second application while one
   * stands, an invalid proposal, an empty decision, and any update whose
   * guard no longer matches the live row.
   */
  async function apply(
    workflowId: number,
    decision: ProposalDecision,
    appliedBy: string | null,
  ): Promise<Result<ApplyResult, OctError>> {
    const proposal = await loadProposal(workflowId);
    if (!proposal.ok) return proposal;

    const standing = await ledger.findByWorkflow(workflowId);
    if (!standing.ok) return standing;
    if (standing.value && standing.value.revertedAt === null) {
      return err(
        failure('proposal_already_applied', `Workflow ${workflowId} was applied at ${standing.value.appliedAt}`),
      );
    }

    const issues = validateProposal(proposal.value);
    if (issues.length > 0) {
      return err(failure('proposal_invalid', issues.map((issue) => issue.message).join(' ')));
    }

    const resolved = resolveDecision(proposal.value, decision);
    if (resolved.length === 0) return err(failure('proposal_invalid', 'The decision accepts nothing'));

    const contact = await contactOf(proposal.value.scope);
    if (!contact.ok) return contact;

    const drifted = detectDrift(resolved, (op) => (isBriefUpdate(op) ? contact.value.brief : undefined));
    if (drifted.length > 0) {
      return err(
        failure(
          'proposal_drift',
          `The contact changed since the proposal was made (operations ${drifted.map((d) => d.operationId).join(', ')}). Review it again.`,
        ),
      );
    }

    const created: Record<string, string> = {};
    for (const op of resolved) {
      const written = await applyOperation(op, contact.value);
      if (!written.ok) return written;
      if (written.value) created[written.value.ref] = written.value.id;
    }

    const recorded = await ledger.record({
      principal: actingAs(appliedBy),
      mode: 'reviewed',
      scope: proposal.value.scope,
      workflowId,
      decision,
      operations: resolved,
      created,
      reversibility: reversibilityOf(resolved),
      appliedAt: dateProvider.now().toISOString(),
    });
    if (!recorded.ok) return recorded;

    return ok({ appliedAt: recorded.value.appliedAt, created });
  }

  /** Undo an application: the inverse operations, through the same writes. */
  async function revert(workflowId: number, revertedBy: string | null): Promise<Result<RevertResult, OctError>> {
    const standing = await ledger.findByWorkflow(workflowId);
    if (!standing.ok) return standing;
    if (!standing.value) return err(failure('proposal_not_applied', `Workflow ${workflowId} has not been applied`));
    if (standing.value.revertedAt !== null) {
      return err(failure('proposal_already_reverted', `Workflow ${workflowId} was reverted at ${standing.value.revertedAt}`));
    }

    const contact = await contactOf(standing.value.scope);
    if (!contact.ok) return contact;

    // The ledger stored what this host wrote — its own `ResolvedOperation[]`.
    const plan = invertOperations(standing.value.operations as ResolvedOperation[], standing.value.created);
    for (const op of plan.operations) {
      const written = await applyOperation(op, contact.value);
      if (!written.ok) return written;
    }

    const revertedAt = dateProvider.now().toISOString();
    const marked = await ledger.markReverted(standing.value.id, { at: revertedAt, by: revertedBy ?? 'unknown' });
    if (!marked.ok) return marked;

    return ok({ revertedAt, missing: plan.missing, irreversible: plan.irreversible, compensable: plan.compensable });
  }

  return { loadProposal, apply, revert, ledger };
}

export type ProposalService = ReturnType<typeof createProposalService>;
