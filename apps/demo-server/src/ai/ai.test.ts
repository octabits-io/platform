/**
 * The AI workflow end to end, fully in memory — no Postgres, no pg-boss, no
 * network, no API key.
 *
 * Drives the real `/api/ai` routes through the shared test harness: trigger → drain the
 * in-process queue (the stand-in for the pg-boss step worker) → poll status →
 * assert the kit-shaped `AiWorkflowData`, the parallel step layout, the mock
 * model's scripted outputs, and the token/cost rollup the instrumented model
 * captured. The only stubbed domain piece is `contactsService`.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { testRequest } from '@octabits-io/framework/server/testing';
import { testableHonoApp } from '@octabits-io/framework/hono';
import type { Logger } from '@octabits-io/framework/logger';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { ObjectStorageService } from '@octabits-io/framework/storage';
import type { BossManager } from '@octabits-io/framework/queue';
import { ok, err } from '@octabits-io/framework/result';
import { loadConfig } from '../config.ts';
import { buildContainer } from '../container.ts';
import { createDemoApp } from '../app.ts';
import type { Schema } from '../db/schema.ts';
import { createDateProvider } from '@octabits-io/framework/utils';
import { driftDigest } from '@octabits-io/framework/proposal';
import type { Proposal, ProposedOperation } from '@octabits-io/framework/proposal';
import type { ContactsService } from '../services/contacts.ts';
import type { NotesService } from '../services/notes.ts';
import { createInMemoryAiRuntime, type InMemoryAiRuntime } from './testing.ts';
import { createInMemoryProposalApplicationStore, createProposalService } from './proposals.ts';
import { CONTACT_BRIEF_TYPE } from './workflows.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

const CONTACT_ID = '6f7c9a34-0f6f-4a3e-9a5d-222222222222';

/** The one mutable slot the proposal writes — what apply/revert/drift act on. */
const contactState: { brief: string | null } = { brief: null };
/** Read through a call so TS does not narrow the slot to the value the test just assigned. */
const currentBrief = (): string | null => contactState.brief;

const contactsStub = {
  getById: async (id: string) =>
    id === CONTACT_ID
      ? ok({
          id, name: 'Ada Lovelace', email: 'ada@example.com',
          wishStart: '', wishEnd: '', wishNights: null, brief: contactState.brief,
          createdAt: '', updatedAt: '',
        })
      : err({ key: 'contact_not_found' as const, message: `Contact ${id} not found` }),
  update: async (id: string, params: { brief?: string | null }) => {
    if (params.brief !== undefined) contactState.brief = params.brief;
    return contactsStub.getById(id);
  },
} as unknown as ContactsService;

/** Notes the apply side creates (and revert deletes). */
const notesState = new Map<string, { id: string; title: string; body: string }>();
const notesStub = {
  create: async (params: { id: string; title: string; body: string }) => {
    notesState.set(params.id, params);
    return ok(undefined);
  },
  delete: async ({ id }: { id: string }) => {
    notesState.delete(id);
    return ok(undefined);
  },
} as unknown as NotesService;

let app: ReturnType<typeof testableHonoApp>;
let ai: InMemoryAiRuntime;

interface WorkflowData {
  id: number;
  status: string;
  output: { summarize?: { summary: string }; followup?: { draft: string }; propose?: Proposal } | null;
  entityRef: string | null;
  totalSteps: number;
  completedSteps: number;
  steps: { key: string; status: string; dependencies: string[] }[];
  appliedAt: string | null;
}

beforeAll(async () => {
  const config = loadConfig();
  const container = await buildContainer({
    config,
    logger: silentLogger,
    db: {} as AppDatabase<Schema>,
    storage: {} as ObjectStorageService,
    boss: {} as BossManager,
  });
  ai = createInMemoryAiRuntime({ host: { contactsService: contactsStub, logger: silentLogger }, logger: silentLogger });
  // The apply side, on the same in-memory engine plus the two domain stubs.
  const proposals = createProposalService({
    engine: ai.engine,
    contacts: contactsStub,
    notes: notesStub,
    applications: createInMemoryProposalApplicationStore(),
    dateProvider: createDateProvider(),
  });
  app = testableHonoApp(createDemoApp({ container, config, ai: { ...ai, proposals }, checkReady: async () => {} }));
});

describe('AI workflow routes (fully in-memory)', () => {
  it('runs contact-brief end to end: trigger → drain → completed', async () => {
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: CONTACT_ID },
    });
    expect(triggered.status).toBe(202);
    const { workflowId, totalSteps } = triggered.data as { workflowId: number; totalSteps: number };
    expect(totalSteps).toBe(4);

    // The entity probe sees it in flight before any step ran.
    const probe = await testRequest(app, 'GET', `/api/ai/workflows/active?entityRef=contact:${CONTACT_ID}`);
    expect((probe.data as { active: boolean }).active).toBe(true);

    await ai.drain();

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    expect(res.status).toBe(200);
    const workflow = res.data as WorkflowData;

    expect(workflow.status).toBe('completed');
    expect(workflow.completedSteps).toBe(4);
    expect(workflow.entityRef).toBe(`contact:${CONTACT_ID}`);
    expect(workflow.appliedAt).toBeNull();

    // The DAG: summarize + followup both hang off fetch (parallel branches).
    const byKey = Object.fromEntries(workflow.steps.map((s) => [s.key, s]));
    expect(byKey.fetch?.dependencies).toEqual([]);
    expect(byKey.summarize?.dependencies).toEqual(['fetch']);
    expect(byKey.followup?.dependencies).toEqual(['fetch']);
    expect([...(byKey.propose?.dependencies ?? [])].sort()).toEqual(['fetch', 'followup', 'summarize']);

    // Output aggregates one key per step; the scripted model used the contact.
    expect(workflow.output?.summarize?.summary).toContain('Ada Lovelace');
    expect(workflow.output?.followup?.draft).toContain('Hi Ada Lovelace');

    // The instrumented model captured usage for both AI steps — never the fetch.
    expect(ai.stepUsage).toHaveLength(2);
    for (const usage of ai.stepUsage) {
      expect(usage.modelId).toBe('demo-mock-model');
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.costMicros).toBeGreaterThan(0);
    }

    // Terminal state: the probe clears.
    const probeAfter = await testRequest(app, 'GET', `/api/ai/workflows/active?entityRef=contact:${CONTACT_ID}`);
    expect((probeAfter.data as { active: boolean }).active).toBe(false);

    // The list read (the SPA's rehydration path) returns it newest-first.
    const listed = await testRequest(app, 'GET', `/api/ai/workflows?entityRef=contact:${CONTACT_ID}&limit=1`);
    expect(listed.status).toBe(200);
    expect((listed.data as { items: WorkflowData[] }).items[0]?.id).toBe(workflowId);
  });

  it('serves the progress-store snapshot projection', async () => {
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: CONTACT_ID },
    });
    const { workflowId } = triggered.data as { workflowId: number };
    await ai.drain();

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}/status`);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'completed', totalSteps: 4, completedSteps: 4 });
  });

  it('rolls completed workflows into the daily usage aggregate', async () => {
    // The completion hook fires without blocking the workflow — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await testRequest(app, 'GET', '/api/ai/usage');
    expect(res.status).toBe(200);
    const usage = res.data as {
      byDate: { workflowCount: number; inputTokens: number; estimatedCostMicros: number }[];
      current: { running: { count: number } };
    };
    const today = usage.byDate[0];
    expect(today?.workflowCount).toBeGreaterThanOrEqual(2);
    expect(today?.inputTokens).toBeGreaterThan(0);
    expect(today?.estimatedCostMicros).toBeGreaterThan(0);
    expect(usage.current.running.count).toBe(0);
  });

  it('fails the workflow when the fetch step throws (missing contact)', async () => {
    const missing = '6f7c9a34-0f6f-4a3e-9a5d-333333333333';
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: missing },
    });
    const { workflowId } = triggered.data as { workflowId: number };
    await ai.drain();

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    const workflow = res.data as WorkflowData;
    expect(workflow.status).toBe('failed');
    // Dependent steps never ran — skipped, not failed.
    const byKey = Object.fromEntries(workflow.steps.map((s) => [s.key, s]));
    expect(byKey.fetch?.status).toBe('failed');
    expect(byKey.summarize?.status).toBe('skipped');
    expect(byKey.followup?.status).toBe('skipped');
    expect(byKey.propose?.status).toBe('skipped');
  });

  it('404s an unknown workflow id', async () => {
    const res = await testRequest(app, 'GET', '/api/ai/workflows/999999');
    expect(res.status).toBe(404);
    expect((res.data as { key: string }).key).toBe('workflow_not_found');
  });

  it('cancels a workflow before its steps run', async () => {
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: CONTACT_ID },
    });
    const { workflowId } = triggered.data as { workflowId: number };

    const cancelled = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/cancel`);
    expect(cancelled.status).toBe(200);

    await ai.drain(); // queued jobs for a cancelled workflow must be harmless

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    expect((res.data as WorkflowData).status).toBe('cancelled');
  });
});

/**
 * The review loop — layer 3 of the review kit, the part a host writes. The
 * proposal is produced by the run, the decision is the card's output, and the
 * apply/revert routes are the only writers. Each test starts from a known
 * `contactState` because the proposal's `current` and `guard` are read from it.
 */
describe('proposal review loop (apply / revert)', () => {
  async function completedRun() {
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: CONTACT_ID },
    });
    const { workflowId } = triggered.data as { workflowId: number };
    await ai.drain();
    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    const workflow = res.data as WorkflowData;
    const proposal = workflow.output?.propose;
    if (!proposal) throw new Error('run produced no proposal');
    const update = proposal.operations.find((op): op is ProposedOperation & { op: 'update' } => op.op === 'update');
    const create = proposal.operations.find((op): op is ProposedOperation & { op: 'create' } => op.op === 'create');
    if (!update || !create) throw new Error('proposal is missing an operation');
    return { workflowId, proposal, update, create };
  }

  it('the final step emits a proposal that says what each value replaces', async () => {
    contactState.brief = null;
    const { proposal, update, create } = await completedRun();

    expect(proposal.scope).toBe(`contact:${CONTACT_ID}`);
    expect(proposal.workflowType).toBe(CONTACT_BRIEF_TYPE);
    // `current` was read at emit time and is null — and the guard is its digest.
    expect(update).toMatchObject({
      target: { kind: 'entity', type: 'contact', id: CONTACT_ID, label: 'Ada Lovelace' },
      path: ['brief'],
      current: null,
      guard: driftDigest(null),
    });
    expect(String(update.proposed)).toContain('Ada Lovelace');
    expect(update.display?.control).toBe('multiline');
    expect(create).toMatchObject({ collection: 'notes', ref: 'followup' });
    expect(String(create.value)).toContain('Hi Ada Lovelace');
    expect(proposal.provenance).toMatchObject({ model: 'demo-mock-model', keySource: 'platform' });
    expect(proposal.applied).toBeNull();
  });

  it('applies a partial decision with an edit, keeps the audit row, and refuses a second apply', async () => {
    contactState.brief = null;
    notesState.clear();
    const { workflowId, update, create } = await completedRun();

    const applied = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/apply`, {
      body: { accepted: [update.id, create.id], edits: [{ id: update.id, value: 'Edited brief' }] },
    });
    expect(applied.status).toBe(200);
    const { appliedAt, created } = applied.data as { appliedAt: string; created: Record<string, string> };

    // The edit, not the proposal, is what was written; the note got the host's title.
    expect(currentBrief()).toBe('Edited brief');
    expect(notesState.size).toBe(1);
    const note = [...notesState.values()][0]!;
    expect(note.title).toBe('Follow-up: Ada Lovelace');
    expect(note.body).toBe(String(create.value));
    expect(created.followup).toBe(note.id);

    // The wire view projects appliedAt from the audit row.
    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    expect((res.data as WorkflowData).appliedAt).toBe(appliedAt);

    const again = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/apply`, {
      body: { accepted: [update.id] },
    });
    expect(again.status).toBe(409);
    expect((again.data as { key: string }).key).toBe('proposal_already_applied');
  });

  it('refuses to apply over a brief that changed since the proposal was made', async () => {
    contactState.brief = null;
    const { workflowId, update } = await completedRun();

    contactState.brief = 'Someone typed here meanwhile';
    const res = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/apply`, {
      body: { accepted: [update.id] },
    });

    expect(res.status).toBe(409);
    expect((res.data as { key: string; message: string }).key).toBe('proposal_drift');
    expect((res.data as { message: string }).message).toContain(update.id);
    expect(currentBrief()).toBe('Someone typed here meanwhile');
  });

  it('reverts from the audit row: restores the brief, deletes the note, clears appliedAt', async () => {
    contactState.brief = 'Before';
    notesState.clear();
    const { workflowId, update, create } = await completedRun();
    expect(update.current).toBe('Before');

    const notApplied = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/revert`);
    expect(notApplied.status).toBe(409);
    expect((notApplied.data as { key: string }).key).toBe('proposal_not_applied');

    await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/apply`, {
      body: { accepted: [update.id, create.id] },
    });
    expect(currentBrief()).not.toBe('Before');
    expect(notesState.size).toBe(1);

    const reverted = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/revert`);
    expect(reverted.status).toBe(200);
    expect((reverted.data as { missing: string[] }).missing).toEqual([]);
    expect(currentBrief()).toBe('Before');
    expect(notesState.size).toBe(0);

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    const workflow = res.data as WorkflowData & { revertedAt: string | null };
    expect(workflow.appliedAt).toBeNull();
    expect(workflow.revertedAt).not.toBeNull();

    const twice = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/revert`);
    expect(twice.status).toBe(409);
    expect((twice.data as { key: string }).key).toBe('proposal_already_reverted');
  });

  it('rejects a decision that accepts nothing', async () => {
    contactState.brief = null;
    const { workflowId } = await completedRun();
    const res = await testRequest(app, 'POST', `/api/ai/workflows/${workflowId}/apply`, { body: { accepted: [] } });
    expect(res.status).toBe(400);
    expect((res.data as { key: string }).key).toBe('proposal_invalid');
  });
});
