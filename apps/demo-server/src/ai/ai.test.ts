/**
 * The AI workflow end to end, fully in memory — no Postgres, no pg-boss, no
 * network, no API key.
 *
 * Drives the real `/api/ai` routes through `app.handle`: trigger → drain the
 * in-process queue (the stand-in for the pg-boss step worker) → poll status →
 * assert the kit-shaped `AiWorkflowData`, the parallel step layout, the mock
 * model's scripted outputs, and the token/cost rollup the instrumented model
 * captured. The only stubbed domain piece is `contactsService`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { testRequest } from '@octabits-io/framework/elysia/testing';
import type { Logger } from '@octabits-io/framework/logger';
import type { AppDatabase } from '@octabits-io/framework/drizzle/factory';
import type { ObjectStorageService } from '@octabits-io/framework/storage';
import type { BossManager } from '@octabits-io/framework/queue';
import { ok, err } from '@octabits-io/framework/result';
import { loadConfig } from '../config.ts';
import { buildContainer } from '../container.ts';
import { createDemoApp, type App } from '../app.ts';
import type { Schema } from '../db/schema.ts';
import type { ContactsService } from '../services/contacts.ts';
import { createInMemoryAiRuntime, type InMemoryAiRuntime } from './testing.ts';
import { CONTACT_BRIEF_TYPE } from './workflows.ts';

const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silentLogger,
};

const CONTACT_ID = '6f7c9a34-0f6f-4a3e-9a5d-222222222222';

const contactsStub = {
  getById: async (id: string) =>
    id === CONTACT_ID
      ? ok({ id, name: 'Ada Lovelace', email: 'ada@example.com', createdAt: '', updatedAt: '' })
      : err({ key: 'contact_not_found' as const, message: `Contact ${id} not found` }),
} as unknown as ContactsService;

let app: App;
let ai: InMemoryAiRuntime;

interface WorkflowData {
  id: number;
  status: string;
  output: Record<string, { summary?: string; draft?: string }> | null;
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
  app = createDemoApp({ container, config, ai, checkReady: async () => {} });
});

describe('AI workflow routes (fully in-memory)', () => {
  it('runs contact-brief end to end: trigger → drain → completed', async () => {
    const triggered = await testRequest(app, 'POST', '/api/ai/workflows', {
      body: { type: CONTACT_BRIEF_TYPE, contactId: CONTACT_ID },
    });
    expect(triggered.status).toBe(202);
    const { workflowId, totalSteps } = triggered.data as { workflowId: number; totalSteps: number };
    expect(totalSteps).toBe(3);

    // The entity probe sees it in flight before any step ran.
    const probe = await testRequest(app, 'GET', `/api/ai/workflows/active?entityRef=contact:${CONTACT_ID}`);
    expect((probe.data as { active: boolean }).active).toBe(true);

    await ai.drain();

    const res = await testRequest(app, 'GET', `/api/ai/workflows/${workflowId}`);
    expect(res.status).toBe(200);
    const workflow = res.data as WorkflowData;

    expect(workflow.status).toBe('completed');
    expect(workflow.completedSteps).toBe(3);
    expect(workflow.entityRef).toBe(`contact:${CONTACT_ID}`);
    expect(workflow.appliedAt).toBeNull();

    // The DAG: summarize + followup both hang off fetch (parallel branches).
    const byKey = Object.fromEntries(workflow.steps.map((s) => [s.key, s]));
    expect(byKey.fetch?.dependencies).toEqual([]);
    expect(byKey.summarize?.dependencies).toEqual(['fetch']);
    expect(byKey.followup?.dependencies).toEqual(['fetch']);

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
    expect(res.data).toEqual({ status: 'completed', totalSteps: 3, completedSteps: 3 });
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
