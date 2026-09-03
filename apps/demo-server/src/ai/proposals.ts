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
 *   4. **The audit row.** One `proposal_applications` row per application:
 *      the decision, the resolved operations as written, the ids the host
 *      assigned to creates. That row is what `appliedAt` on the wire is
 *      projected from, and what revert reads — a revert never re-reads the
 *      entity to guess what "before" was.
 *   5. **Revert as a second application.** `invertOperations` turns the audit
 *      row into the operations that undo it, and they go through the same
 *      `applyOperation`. Nothing revert-specific touches a table.
 *
 * What a production host adds and this demo does not: one transaction around
 * the writes (these services take no `tx`), authorization (the demo has a
 * role header, not an identity), and per-scope routing of the engine.
 */
import { eq, inArray } from 'drizzle-orm';
import { ok, err } from '@octabits-io/framework/result';
import type { OctError, Result } from '@octabits-io/framework/result';
import { withDbErrorHandling } from '@octabits-io/framework/drizzle/db';
import type { OctDatabaseError } from '@octabits-io/framework/drizzle/db';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { DateProvider } from '@octabits-io/framework/utils';
import {
  detectDrift,
  invertOperations,
  parseEntityRef,
  proposalSchema,
  resolveDecision,
  validateProposal,
} from '@octabits-io/framework/proposal';
import type {
  Proposal,
  ProposalDecision,
  ProposedOperation,
  ResolvedOperation,
} from '@octabits-io/framework/proposal';
import { proposalApplications, type Schema } from '../db/schema.ts';
import type { Contact, ContactsService } from '../services/contacts.ts';
import type { NotesService } from '../services/notes.ts';
import type { DemoAiEngine } from './engine.ts';
import { PROPOSAL_TARGETS } from './workflows.ts';

// ============================================================================
// The audit row
// ============================================================================

export interface ProposalApplicationRecord {
  workflowId: number;
  scope: string;
  decision: ProposalDecision;
  /** The operations exactly as written — edits folded in, `current` intact. */
  applied: ResolvedOperation[];
  /** Ids this host assigned to creates, by the create's `ref`. */
  created: Record<string, string>;
  appliedAt: string;
  appliedBy: string | null;
  revertedAt: string | null;
}

export interface ProposalApplicationStore {
  get(workflowId: number): Promise<Result<ProposalApplicationRecord | null, OctDatabaseError>>;
  /** Batched read for the workflow list projection (`extendWorkflow.load`). */
  getMany(workflowIds: number[]): Promise<Result<Map<number, ProposalApplicationRecord>, OctDatabaseError>>;
  /** Insert, or replace a reverted application with a fresh one. */
  upsert(record: ProposalApplicationRecord): Promise<Result<void, OctDatabaseError>>;
  markReverted(workflowId: number, revertedAt: string): Promise<Result<void, OctDatabaseError>>;
}

/** The Drizzle store over `proposal_applications` (schema.ts). */
export function createDrizzleProposalApplicationStore(db: AppDatabase<Schema>): ProposalApplicationStore {
  type Row = typeof proposalApplications.$inferSelect;
  const toRecord = (row: Row): ProposalApplicationRecord => ({
    workflowId: row.workflowId,
    scope: row.scope,
    decision: row.decision,
    applied: row.applied,
    created: row.created,
    appliedAt: row.appliedAt.toISOString(),
    appliedBy: row.appliedBy,
    revertedAt: row.revertedAt?.toISOString() ?? null,
  });

  return {
    get: (workflowId) =>
      withDbErrorHandling(async () => {
        const [row] = await db
          .select()
          .from(proposalApplications)
          .where(eq(proposalApplications.workflowId, workflowId))
          .limit(1);
        return ok(row ? toRecord(row) : null);
      }),
    getMany: (workflowIds) =>
      withDbErrorHandling(async () => {
        if (workflowIds.length === 0) return ok(new Map());
        const rows = await db
          .select()
          .from(proposalApplications)
          .where(inArray(proposalApplications.workflowId, workflowIds));
        return ok(new Map(rows.map((row) => [row.workflowId, toRecord(row)])));
      }),
    upsert: (record) =>
      withDbErrorHandling(async () => {
        const values = {
          workflowId: record.workflowId,
          scope: record.scope,
          decision: record.decision,
          applied: record.applied,
          created: record.created,
          appliedAt: new Date(record.appliedAt),
          appliedBy: record.appliedBy,
          revertedAt: record.revertedAt ? new Date(record.revertedAt) : null,
        };
        await db
          .insert(proposalApplications)
          .values(values)
          .onConflictDoUpdate({ target: proposalApplications.workflowId, set: values });
        return ok(undefined);
      }),
    markReverted: (workflowId, revertedAt) =>
      withDbErrorHandling(async () => {
        await db
          .update(proposalApplications)
          .set({ revertedAt: new Date(revertedAt) })
          .where(eq(proposalApplications.workflowId, workflowId));
        return ok(undefined);
      }),
  };
}

/** The no-database twin, for the in-memory test runtime. */
export function createInMemoryProposalApplicationStore(): ProposalApplicationStore {
  const rows = new Map<number, ProposalApplicationRecord>();
  return {
    get: async (workflowId) => ok(rows.get(workflowId) ?? null),
    getMany: async (workflowIds) =>
      ok(new Map(workflowIds.flatMap((id) => (rows.has(id) ? [[id, rows.get(id)!] as const] : [])))),
    upsert: async (record) => {
      rows.set(record.workflowId, { ...record });
      return ok(undefined);
    },
    markReverted: async (workflowId, revertedAt) => {
      const row = rows.get(workflowId);
      if (row) rows.set(workflowId, { ...row, revertedAt });
      return ok(undefined);
    },
  };
}

// ============================================================================
// The service
// ============================================================================

export interface ProposalServiceDeps {
  engine: Pick<DemoAiEngine, 'getWorkflowStatus'>;
  contacts: Pick<ContactsService, 'getById' | 'update'>;
  notes: Pick<NotesService, 'create' | 'delete'>;
  applications: ProposalApplicationStore;
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
}

const failure = (key: string, message: string): OctError => ({ key, message });

export function createProposalService({ engine, contacts, notes, applications, dateProvider }: ProposalServiceDeps) {
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

    const existing = await applications.get(workflowId);
    if (!existing.ok) return existing;
    if (existing.value && existing.value.revertedAt === null) {
      return err(
        failure('proposal_already_applied', `Workflow ${workflowId} was applied at ${existing.value.appliedAt}`),
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

    const appliedAt = dateProvider.now().toISOString();
    const stored = await applications.upsert({
      workflowId,
      scope: proposal.value.scope,
      decision,
      applied: resolved,
      created,
      appliedAt,
      appliedBy,
      revertedAt: null,
    });
    if (!stored.ok) return stored;

    return ok({ appliedAt, created });
  }

  /** Undo an application: the inverse operations, through the same writes. */
  async function revert(workflowId: number): Promise<Result<RevertResult, OctError>> {
    const existing = await applications.get(workflowId);
    if (!existing.ok) return existing;
    if (!existing.value) return err(failure('proposal_not_applied', `Workflow ${workflowId} has not been applied`));
    if (existing.value.revertedAt !== null) {
      return err(failure('proposal_already_reverted', `Workflow ${workflowId} was reverted at ${existing.value.revertedAt}`));
    }

    const contact = await contactOf(existing.value.scope);
    if (!contact.ok) return contact;

    const plan = invertOperations(existing.value.applied, existing.value.created);
    for (const op of plan.operations) {
      const written = await applyOperation(op, contact.value);
      if (!written.ok) return written;
    }

    const revertedAt = dateProvider.now().toISOString();
    const marked = await applications.markReverted(workflowId, revertedAt);
    if (!marked.ok) return marked;

    return ok({ revertedAt, missing: plan.missing });
  }

  return { loadProposal, apply, revert, applications };
}

export type ProposalService = ReturnType<typeof createProposalService>;
