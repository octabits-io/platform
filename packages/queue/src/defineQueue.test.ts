import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import { defineQueue, SCHEMA_SCOPED_JOB_PAYLOAD } from './index.ts';
import type { QueueScope, QueueScopeFactory } from './index.ts';

// ---------------------------------------------------------------------------
// Test payload + schema
// ---------------------------------------------------------------------------

const SCHEMA_TEST_JOB = SCHEMA_SCOPED_JOB_PAYLOAD.extend({
  to: z.email(),
});
type TestJob = z.infer<typeof SCHEMA_TEST_JOB>;

const validPayload: TestJob = { scopeKey: 't1', to: 'a@b.com' };

// ---------------------------------------------------------------------------
// pg-boss mock (no live Postgres)
// ---------------------------------------------------------------------------

function createMockBoss() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('job-123'),
    work: vi.fn().mockResolvedValue('worker-1'),
    offWork: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
  };
}

type MockBoss = ReturnType<typeof createMockBoss>;

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

// A disposable scope + factory that records how it was called.
function createScopeStub() {
  const scope: QueueScope & { dispose: ReturnType<typeof vi.fn> } = {
    resolve: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const createSystemScope = vi.fn(async () => scope) as unknown as QueueScopeFactory & {
    mock: ReturnType<typeof vi.fn>['mock'];
  };
  return { scope, createSystemScope };
}

type BatchHandler = (
  jobs: unknown[],
) => Promise<Array<{ id: string; status: string; output?: unknown }> | void>;

// A vanilla definition used across most tests.
function defineTestQueue(overrides: Partial<Parameters<typeof defineQueue<TestJob>>[0]> = {}) {
  return defineQueue<TestJob>({
    name: 'email',
    schema: SCHEMA_TEST_JOB,
    createHandler: () => vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    resolveScopeKey: (data) => data.scopeKey,
    ...overrides,
  });
}

// ===========================================================================
// defineQueue — wiring
// ===========================================================================

describe('defineQueue — definition wiring', () => {
  it('resolves config with a `${name}-dlq` and default retry/expire, exposes the schema + factories', () => {
    const def = defineTestQueue();

    expect(def.config).toEqual({
      name: 'email',
      dlq: 'email-dlq',
      schema: SCHEMA_TEST_JOB,
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 60,
    });
    expect(def.schema).toBe(SCHEMA_TEST_JOB);
    expect(typeof def.createEnqueuer).toBe('function');
    expect(typeof def.createWorker).toBe('function');
    expect(typeof def.createDlqHandler).toBe('function');
  });

  it('passes retry/expire config overrides through to the underlying queue domain', async () => {
    const boss = createMockBoss();
    const def = defineTestQueue({
      config: { retryLimit: 7, retryDelay: 42, expireInSeconds: 120 },
    });

    expect(def.config).toMatchObject({ retryLimit: 7, retryDelay: 42, expireInSeconds: 120 });

    const { enqueue } = def.createEnqueuer({ boss: boss as unknown as PgBoss });
    await enqueue(validPayload);

    // Main queue created + job sent with the overridden options.
    expect(boss.createQueue).toHaveBeenNthCalledWith(
      2,
      'email',
      expect.objectContaining({ retryLimit: 7, retryDelay: 42, expireInSeconds: 120 }),
    );
    expect(boss.send).toHaveBeenCalledWith(
      'email',
      validPayload,
      expect.objectContaining({ retryLimit: 7, retryDelay: 42, expireInSeconds: 120 }),
    );
  });
});

// ===========================================================================
// defineQueue — enqueuer validation
// ===========================================================================

describe('defineQueue — enqueuer', () => {
  let boss: MockBoss;

  beforeEach(() => {
    boss = createMockBoss();
  });

  it('enqueues a valid payload and returns the job id + queue', async () => {
    const { enqueue } = defineTestQueue().createEnqueuer({ boss: boss as unknown as PgBoss });
    const result = await enqueue(validPayload);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ jobId: 'job-123', queue: 'email' });
  });

  it('rejects an invalid payload without touching pg-boss (fail fast)', async () => {
    const { enqueue } = defineTestQueue().createEnqueuer({ boss: boss as unknown as PgBoss });
    const result = await enqueue({ to: 'not-an-email' } as unknown as TestJob);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('payload_validation_error');
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('schedules a validated recurring job through the definition', async () => {
    const { schedule } = defineTestQueue().createEnqueuer({ boss: boss as unknown as PgBoss });
    const result = await schedule('nightly', '0 0 * * *', validPayload);

    expect(result.ok).toBe(true);
    expect(boss.schedule).toHaveBeenCalledWith(
      'email',
      '0 0 * * *',
      validPayload,
      expect.objectContaining({ key: 'nightly' }),
    );
  });
});

// ===========================================================================
// defineQueue — worker
// ===========================================================================

describe('defineQueue — worker', () => {
  it('builds the handler from createHandler(deps) and wires a per-job-acking worker', async () => {
    const boss = createMockBoss();
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const createHandler = vi.fn(() => handler);
    const { createSystemScope } = createScopeStub();

    const def = defineTestQueue({ createHandler });
    const worker = def.createWorker({ boss: boss as unknown as PgBoss, logger });
    const result = await worker.startWorker({ createSystemScope });

    expect(result.ok).toBe(true);
    // The handler factory receives the scope factory + logger.
    expect(createHandler).toHaveBeenCalledWith(
      expect.objectContaining({ createSystemScope, logger }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ perJobResults: true, includeMetadata: true }),
      expect.any(Function),
    );

    // Drive the registered batch handler with a valid job → handler invoked.
    const batch = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batch([{ id: 'j1', name: 'email', data: validPayload, retryCount: 0 }]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', data: validPayload }));
    expect(results).toEqual([{ id: 'j1', status: 'completed' }]);
  });

  it('routes a schema-invalid payload straight to the DLQ without invoking the handler', async () => {
    const boss = createMockBoss();
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    const { createSystemScope } = createScopeStub();

    const def = defineTestQueue({ createHandler: () => handler });
    await def.createWorker({ boss: boss as unknown as PgBoss, logger }).startWorker({
      createSystemScope,
    });

    const batch = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batch([{ id: 'bad', name: 'email', data: { to: 'nope' }, retryCount: 0 }]);

    expect(results).toEqual([expect.objectContaining({ id: 'bad', status: 'deadletter' })]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('stops the underlying worker', async () => {
    const boss = createMockBoss();
    const { createSystemScope } = createScopeStub();
    const worker = defineTestQueue().createWorker({ boss: boss as unknown as PgBoss, logger });

    await worker.startWorker({ createSystemScope });
    await worker.stop();
    expect(boss.offWork).toHaveBeenCalledWith('worker-1');
  });
});

// ===========================================================================
// defineQueue — DLQ handler + audit sink
// ===========================================================================

describe('defineQueue — DLQ handler', () => {
  beforeEach(() => {
    logger.error.mockClear();
  });

  it('registers a DLQ worker on the `${name}-dlq` queue', async () => {
    const boss = createMockBoss();
    const { createSystemScope } = createScopeStub();

    const result = await defineTestQueue()
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    expect(result.ok).toBe(true);
    expect(boss.work).toHaveBeenCalledWith(
      'email-dlq',
      expect.objectContaining({ pollingIntervalSeconds: 30 }),
      expect.any(Function),
    );
  });

  it('ensures the DLQ queue exists before registering the worker (fresh-db boot)', async () => {
    const boss = createMockBoss();
    const { createSystemScope } = createScopeStub();

    const result = await defineTestQueue()
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    expect(result.ok).toBe(true);
    // The DLQ queue is created (retryLimit 0) so a dedicated DLQ-consumer
    // process booting first doesn't poll a non-existent queue.
    expect(boss.createQueue).toHaveBeenCalledWith(
      'email-dlq',
      expect.objectContaining({ retryLimit: 0 }),
    );
    // ...and the create happens strictly before boss.work is registered.
    const createOrder = boss.createQueue.mock.invocationCallOrder[0]!;
    const workOrder = boss.work.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(workOrder);
  });

  it('surfaces a failed DLQ-queue ensure as a queue_error Result (never registers the worker)', async () => {
    const boss = createMockBoss();
    boss.createQueue.mockRejectedValueOnce(new Error('permission denied'));
    const { createSystemScope } = createScopeStub();

    const result = await defineTestQueue()
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('queue_error');
      expect(result.error.message).toContain('permission denied');
      expect(result.error.queue).toBe('email-dlq');
    }
    expect(boss.work).not.toHaveBeenCalled();
  });

  it('creates a scope keyed by resolveScopeKey, runs onDlq, invokes the audit sink, and disposes', async () => {
    const boss = createMockBoss();
    const { scope, createSystemScope } = createScopeStub();
    const onDlq = vi.fn().mockResolvedValue(undefined);
    const onDlqAudit = vi.fn().mockResolvedValue(undefined);

    await defineTestQueue({ onDlq, onDlqAudit, config: { retryLimit: 5 } })
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const job = { id: 'dead-1', name: 'email-dlq', data: validPayload };
    await dlqHandler([job]);

    // Scope bound to the payload-derived partition key.
    expect(createSystemScope).toHaveBeenCalledWith('t1');
    // Domain hook runs before the audit sink, both against the same scope.
    expect(onDlq).toHaveBeenCalledWith(scope, job, validPayload);
    expect(onDlqAudit).toHaveBeenCalledWith(scope, {
      queueName: 'email',
      jobId: 'dead-1',
      jobType: 'email',
      status: 'dead_letter',
      payload: validPayload,
      errorMessage: 'Exhausted all retry attempts',
      attemptCount: 5,
      completedAt: expect.any(String),
      validPayload: true,
      scopeKey: 't1',
    });
    const auditOrder = onDlqAudit.mock.invocationCallOrder[0]!;
    const hookOrder = onDlq.mock.invocationCallOrder[0]!;
    expect(hookOrder).toBeLessThan(auditOrder);
    // Error is logged and the scope is always disposed.
    expect(logger.error).toHaveBeenCalledWith(
      'email job moved to dead letter queue',
      undefined,
      expect.objectContaining({ jobId: 'dead-1', scopeKey: 't1', validPayload: true }),
    );
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('marks validPayload false and omits scopeKey when the DLQ payload fails validation', async () => {
    const boss = createMockBoss();
    const { createSystemScope } = createScopeStub();
    const onDlqAudit = vi.fn().mockResolvedValue(undefined);

    await defineTestQueue({ onDlqAudit })
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    await dlqHandler([{ id: 'dead-2', name: 'email-dlq', data: { to: 'nope' } }]);

    // Invalid payload → no scopeKey extracted → scope created without a key.
    expect(createSystemScope).toHaveBeenCalledWith(undefined);
    const record = onDlqAudit.mock.calls[0]![1] as Record<string, unknown>;
    expect(record.validPayload).toBe(false);
    expect(record).not.toHaveProperty('scopeKey');
    expect(record.payload).toEqual({ to: 'nope' });
  });

  it('is a no-op audit-wise but still logs + disposes when no audit sink is provided', async () => {
    const boss = createMockBoss();
    const { scope, createSystemScope } = createScopeStub();

    // No onDlq / onDlqAudit.
    await defineTestQueue()
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    await expect(
      dlqHandler([{ id: 'dead-3', name: 'email-dlq', data: validPayload }]),
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      'email job moved to dead letter queue',
      undefined,
      expect.objectContaining({ jobId: 'dead-3' }),
    );
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('swallows an audit-sink error, logging it and still disposing the scope', async () => {
    const boss = createMockBoss();
    const { scope, createSystemScope } = createScopeStub();
    const onDlqAudit = vi.fn().mockRejectedValue(new Error('db down'));

    await defineTestQueue({ onDlqAudit })
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    await expect(
      dlqHandler([{ id: 'dead-4', name: 'email-dlq', data: validPayload }]),
    ).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to run DLQ audit sink',
      expect.any(Error),
      expect.objectContaining({ jobId: 'dead-4' }),
    );
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });

  it('translates a thrown boss.work into a queue_error Result', async () => {
    const boss = createMockBoss();
    boss.work.mockRejectedValueOnce(new Error('connection lost'));
    const { createSystemScope } = createScopeStub();

    const result = await defineTestQueue()
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('queue_error');
      expect(result.error.message).toContain('connection lost');
      expect(result.error.queue).toBe('email-dlq');
    }
  });

  it('stops the DLQ worker only when one is running', async () => {
    const boss = createMockBoss();
    const { createSystemScope } = createScopeStub();
    const dlq = defineTestQueue().createDlqHandler({
      boss: boss as unknown as PgBoss,
      createSystemScope,
      logger,
    });

    await dlq.stop();
    expect(boss.offWork).not.toHaveBeenCalled();

    await dlq.start();
    await dlq.stop();
    expect(boss.offWork).toHaveBeenCalledWith('worker-1');
  });

  it('isolates a poison job (raw-payload callback throw) so batch-mates are still logged + audited', async () => {
    const boss = createMockBoss();
    const { scope, createSystemScope } = createScopeStub();
    const onDlqAudit = vi.fn().mockResolvedValue(undefined);

    // Default resolveScopeKey is `(data) => data.scopeKey`, which throws on the
    // foreign-producer poison job whose `data` is null.
    await defineTestQueue({ onDlqAudit })
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const poison = { id: 'poison', name: 'email-dlq', data: null };
    const healthy = { id: 'ok', name: 'email-dlq', data: validPayload };

    // The whole batch must resolve — one poison job cannot reject it.
    await expect(dlqHandler([poison, healthy])).resolves.not.toThrow();

    // Poison job: scope-key resolution threw → logged, not swallowed silently.
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to resolve DLQ scope key',
      expect.any(Error),
      expect.objectContaining({ jobId: 'poison' }),
    );

    // The healthy batch-mate is still logged + audited with its real scopeKey.
    expect(logger.error).toHaveBeenCalledWith(
      'email job moved to dead letter queue',
      undefined,
      expect.objectContaining({ jobId: 'ok', scopeKey: 't1', validPayload: true }),
    );
    const auditedById = new Map(
      onDlqAudit.mock.calls.map((c) => [(c[1] as { jobId: string }).jobId, c[1]]),
    );
    expect(auditedById.has('ok')).toBe(true);
    expect(auditedById.get('ok')).toMatchObject({ scopeKey: 't1', validPayload: true });
    // Best-effort audit still emitted for the poison job (safe fields only).
    expect(auditedById.get('poison')).toMatchObject({ validPayload: false, payload: null });
    expect(auditedById.get('poison')).not.toHaveProperty('scopeKey');

    // Both scopes disposed — no leak from the poison path.
    expect(scope.dispose).toHaveBeenCalledTimes(2);
  });

  it('keeps the batch alive when createSystemScope itself throws (last-resort guard)', async () => {
    const boss = createMockBoss();
    const onDlqAudit = vi.fn().mockResolvedValue(undefined);
    const createSystemScope = vi
      .fn()
      .mockRejectedValueOnce(new Error('scope boom'))
      .mockResolvedValue({
        resolve: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
      }) as unknown as QueueScopeFactory;

    await defineTestQueue({ onDlqAudit })
      .createDlqHandler({ boss: boss as unknown as PgBoss, createSystemScope, logger })
      .start();

    const dlqHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    await expect(
      dlqHandler([
        { id: 'boom', name: 'email-dlq', data: validPayload },
        { id: 'ok', name: 'email-dlq', data: validPayload },
      ]),
    ).resolves.not.toThrow();

    // First job's scope creation blew up → logged via the last-resort guard.
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to process email dead-letter job',
      expect.any(Error),
      expect.objectContaining({ jobId: 'boom' }),
    );
    // Second job still audited.
    const auditedIds = onDlqAudit.mock.calls.map((c) => (c[1] as { jobId: string }).jobId);
    expect(auditedIds).toContain('ok');
  });
});
