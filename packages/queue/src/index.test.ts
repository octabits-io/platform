import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  createQueueDomain,
  createBossManager,
  createJobNotFoundError,
  createQueueNotFoundError,
  createJobCancelError,
  SCHEMA_SCOPED_JOB_PAYLOAD,
  SCHEMA_BASE_JOB_PAYLOAD,
} from './index.ts';

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
    updateQueue: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue('job-123'),
    work: vi.fn().mockResolvedValue('worker-1'),
    offWork: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
  };
}

type MockBoss = ReturnType<typeof createMockBoss>;

function domainWith(boss: MockBoss) {
  return createQueueDomain<TestJob>(
    { boss: boss as unknown as PgBoss },
    { name: 'email', dlq: 'email-dlq', schema: SCHEMA_TEST_JOB }
  );
}

// ===========================================================================
// createQueueDomain — enqueue
// ===========================================================================

describe('createQueueDomain.enqueue', () => {
  let boss: MockBoss;

  beforeEach(() => {
    boss = createMockBoss();
  });

  it('creates the DLQ first, then the main queue with a deadLetter reference', async () => {
    const domain = domainWith(boss);
    await domain.enqueue(validPayload);

    expect(boss.createQueue).toHaveBeenNthCalledWith(1, 'email-dlq', { retryLimit: 0 });
    expect(boss.createQueue).toHaveBeenNthCalledWith(
      2,
      'email',
      expect.objectContaining({ deadLetter: 'email-dlq' })
    );
  });

  it('syncs settings via updateQueue after createQueue (v12 createQueue is ON CONFLICT DO NOTHING)', async () => {
    // An existing queue would otherwise keep stale settings (e.g. an old
    // deadLetter) forever — createQueue never updates an existing row.
    const domain = domainWith(boss);
    await domain.enqueue(validPayload);

    expect(boss.updateQueue).toHaveBeenNthCalledWith(1, 'email-dlq', { retryLimit: 0 });
    expect(boss.updateQueue).toHaveBeenNthCalledWith(
      2,
      'email',
      expect.objectContaining({
        deadLetter: 'email-dlq',
        retryLimit: 3,
        retryDelay: 10,
        expireInSeconds: 60,
      })
    );
    // createQueue always runs before the corresponding updateQueue.
    expect(boss.createQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      boss.updateQueue.mock.invocationCallOrder[0]!
    );
  });

  it('sends the validated payload and returns the job id + queue', async () => {
    const domain = domainWith(boss);
    const result = await domain.enqueue(validPayload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ jobId: 'job-123', queue: 'email' });
    }
    expect(boss.send).toHaveBeenCalledWith(
      'email',
      validPayload,
      expect.objectContaining({ retryLimit: 3, retryDelay: 10, expireInSeconds: 60 })
    );
  });

  it('rejects an invalid payload without touching pg-boss (fail fast, structured issues)', async () => {
    const domain = domainWith(boss);
    // Missing scopeKey + bad email
    const result = await domain.enqueue({ to: 'not-an-email' } as unknown as TestJob);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('payload_validation_error');
      expect(result.error.queue).toBe('email');
      if (result.error.key === 'payload_validation_error') {
        expect(result.error.issues?.length).toBeGreaterThan(0);
      }
    }
    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.createQueue).not.toHaveBeenCalled();
  });

  it('returns a queue_error when pg-boss.send yields no job id', async () => {
    boss.send.mockResolvedValueOnce(null);
    const domain = domainWith(boss);
    const result = await domain.enqueue(validPayload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.key).toBe('queue_error');
  });

  it('translates a thrown pg-boss error into a queue_error Result', async () => {
    boss.send.mockRejectedValueOnce(new Error('connection lost'));
    const domain = domainWith(boss);
    const result = await domain.enqueue(validPayload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('connection lost');
  });

  it('only creates the queue once across multiple enqueues', async () => {
    const domain = domainWith(boss);
    await domain.enqueue(validPayload);
    await domain.enqueue(validPayload);

    // 2 createQueue calls total (dlq + main), not 4
    expect(boss.createQueue).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// createQueueDomain — startWorker
// ===========================================================================

type BatchHandler = (jobs: unknown[]) => Promise<Array<{ id: string; status: string; output?: unknown }>>;

describe('createQueueDomain.startWorker', () => {
  it('wires a per-job-acking batch worker and validates each job before invoking the handler', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const result = await domain.startWorker(handler, { batchSize: 5 });
    expect(result.ok).toBe(true);
    expect(boss.work).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ batchSize: 5, perJobResults: true, includeMetadata: true }),
      expect.any(Function)
    );

    // Drive the registered batch handler with one valid job
    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 2 },
    ]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', name: 'email', data: validPayload, retryCount: 2 })
    );
    expect(results).toEqual([{ id: 'j1', status: 'completed' }]);
  });

  it('routes an invalid payload straight to the DLQ (deadletter, no retry)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'bad', name: 'email', data: { to: 'nope' }, retryCount: 0 },
    ]);
    expect(results).toEqual([
      expect.objectContaining({ id: 'bad', status: 'deadletter' }),
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('marks a job failed when the handler returns an error Result (triggers retry)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { key: 'job_failed', message: 'boom' } });
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 0 },
    ]);
    expect(results).toEqual([
      { id: 'j1', status: 'failed', output: { message: 'boom' } },
    ]);
  });

  it('acks each job in a batch individually — one failure does not fail its batch-mates', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockImplementation(async (job: { data: TestJob }) =>
      job.data.to === 'fail@b.com'
        ? { ok: false, error: { key: 'job_failed', message: 'nope' } }
        : { ok: true, value: undefined }
    );
    await domain.startWorker(handler, { batchSize: 3 });

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 0 },
      { id: 'j2', name: 'email', data: { ...validPayload, to: 'fail@b.com' }, retryCount: 1 },
      { id: 'j3', name: 'email', data: validPayload, retryCount: 0 },
    ]);

    expect(results).toEqual([
      { id: 'j1', status: 'completed' },
      { id: 'j2', status: 'failed', output: { message: 'nope' } },
      { id: 'j3', status: 'completed' },
    ]);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('marks a job failed when the handler throws, including a truncated stack in the output', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockRejectedValue(new Error('exploded'));
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 0 },
    ]);
    expect(results).toEqual([
      {
        id: 'j1',
        status: 'failed',
        output: expect.objectContaining({ message: 'exploded', stack: expect.any(String) }),
      },
    ]);
    const output = (results[0] as { output: { stack: string } }).output;
    expect(output.stack).toContain('exploded');
    // Stack summary is truncated, not the full trace.
    expect(output.stack.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('propagates JobFailedError cause/jobId/queue into the failure output (JSON-safe)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        key: 'job_failed',
        message: 'smtp send failed',
        jobId: 'j1',
        queue: 'email',
        cause: new TypeError('socket hang up'),
      },
    });
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 0 },
    ]);
    expect(results).toEqual([
      {
        id: 'j1',
        status: 'failed',
        output: {
          message: 'smtp send failed',
          jobId: 'j1',
          queue: 'email',
          cause: 'TypeError: socket hang up',
        },
      },
    ]);
    // The whole output must survive JSON round-tripping (pg-boss persists it).
    const output = (results[0] as { output: unknown }).output;
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });

  it('propagates a thrown error cause summary into the failure output', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('wrapper', { cause: new Error('root cause') }));
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as BatchHandler;
    const results = await batchHandler([
      { id: 'j1', name: 'email', data: validPayload, retryCount: 0 },
    ]);
    expect(results).toEqual([
      {
        id: 'j1',
        status: 'failed',
        output: expect.objectContaining({ message: 'wrapper', cause: 'Error: root cause' }),
      },
    ]);
  });

  it('returns a queue_error when startWorker is called twice without stop (no leaked registration)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const first = await domain.startWorker(handler);
    expect(first.ok).toBe(true);

    const second = await domain.startWorker(handler);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.key).toBe('queue_error');
      expect(second.error.message).toContain('already started');
    }
    // The first registration is untouched — no second boss.work call.
    expect(boss.work).toHaveBeenCalledTimes(1);

    // After stop() the domain can start a fresh worker again.
    await domain.stop();
    const third = await domain.startWorker(handler);
    expect(third.ok).toBe(true);
    expect(boss.work).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// createQueueDomain — schedule + stop
// ===========================================================================

describe('createQueueDomain.schedule / stop', () => {
  it('schedules a validated recurring job with the schedule key', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const result = await domain.schedule('nightly', '0 0 * * *', validPayload);

    expect(result.ok).toBe(true);
    expect(boss.schedule).toHaveBeenCalledWith(
      'email',
      '0 0 * * *',
      validPayload,
      expect.objectContaining({ key: 'nightly' })
    );
  });

  it('rejects scheduling an invalid payload', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const result = await domain.schedule('nightly', '0 0 * * *', {
      scopeKey: '',
      to: 'x',
    } as unknown as TestJob);

    expect(result.ok).toBe(false);
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it('stops the worker by QUEUE NAME only when one is running', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);

    // No worker started yet — stop is a no-op
    await domain.stop();
    expect(boss.offWork).not.toHaveBeenCalled();

    await domain.startWorker(vi.fn().mockResolvedValue({ ok: true, value: undefined }));
    await domain.stop();
    // pg-boss v12 offWork matches by queue name; passing the worker id as the
    // first argument matches nothing (silent no-op). Regression guard: exact args.
    expect(boss.offWork).toHaveBeenCalledTimes(1);
    expect(boss.offWork).toHaveBeenCalledWith('email');
  });

  it('treats the worker as stopped after stop(): a repeat stop() never calls offWork again', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);

    await domain.startWorker(vi.fn().mockResolvedValue({ ok: true, value: undefined }));
    await domain.stop();
    await domain.stop(); // idempotent — the registry is already empty
    expect(boss.offWork).toHaveBeenCalledTimes(1);
    expect(boss.offWork).toHaveBeenCalledWith('email');
  });
});

// ===========================================================================
// createBossManager
// ===========================================================================

describe('createBossManager', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  it('constructs a manager exposing the full lifecycle/monitoring surface', () => {
    const manager = createBossManager({
      connectionString: 'postgres://user:pass@localhost:5432/db',
      logger,
    });

    expect(typeof manager.getBoss).toBe('function');
    expect(typeof manager.start).toBe('function');
    expect(typeof manager.stop).toBe('function');
    expect(typeof manager.getJobById).toBe('function');
    expect(typeof manager.getQueues).toBe('function');
    expect(typeof manager.getQueueStats).toBe('function');
    expect(typeof manager.cancelJob).toBe('function');
  });

  it('returns a pg-boss instance from getBoss()', () => {
    const manager = createBossManager({
      connectionString: 'postgres://user:pass@localhost:5432/db',
      logger,
    });
    const boss = manager.getBoss();
    expect(boss).toBeDefined();
    expect(typeof boss.start).toBe('function');
  });
});

// ===========================================================================
// createBossManager — monitoring methods return Results (no raw pg throws)
// ===========================================================================

describe('createBossManager monitoring — Result conversion', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  function makeManager() {
    const manager = createBossManager({
      connectionString: 'postgres://user:pass@localhost:5432/db',
      logger,
    });
    return { manager, boss: manager.getBoss() };
  }

  const jobRow = {
    id: 'j1',
    name: 'email',
    data: { to: 'a@b.com' },
    state: 'completed',
    retryCount: 1,
    retryLimit: 3,
    startedOn: new Date('2026-01-01T00:00:00Z'),
    completedOn: new Date('2026-01-01T00:00:05Z'),
    createdOn: new Date('2026-01-01T00:00:00Z'),
    expireInSeconds: 60,
    output: { done: true },
  };

  it('getJobById returns ok(JobDetails) when the job exists', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'findJobs').mockResolvedValue([jobRow] as never);

    const result = await manager.getJobById('email', 'j1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        id: 'j1',
        name: 'email',
        state: 'completed',
        retryCount: 1,
        createdOn: '2026-01-01T00:00:00.000Z',
      });
    }
  });

  it('getJobById returns err(job_not_found) instead of null when the job is missing', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'findJobs').mockResolvedValue([] as never);

    const result = await manager.getJobById('email', 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        key: 'job_not_found',
        message: 'Job nope not found in queue email',
        jobId: 'nope',
        queueName: 'email',
      });
    }
  });

  it('getJobById maps a thrown pg error to a queue_error Result instead of throwing', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'findJobs').mockRejectedValue(new Error('connection refused'));

    const result = await manager.getJobById('email', 'j1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('queue_error');
      expect(result.error.message).toContain('connection refused');
    }
  });

  it('getQueues returns ok with mapped + filtered stats, and queue_error on a throw', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'getQueues').mockResolvedValue([
      { name: 'a', deferredCount: 1, queuedCount: 2, activeCount: 3 },
      { name: 'b', deferredCount: 0, queuedCount: 0, activeCount: 0 },
    ] as never);

    const result = await manager.getQueues(['a']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { name: 'a', deferredCount: 1, queuedCount: 2, activeCount: 3, totalCount: 6 },
      ]);
    }

    vi.spyOn(boss, 'getQueues').mockRejectedValue(new Error('boom'));
    const failed = await manager.getQueues();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.key).toBe('queue_error');
  });

  it('getQueueStats returns err(queue_not_found) instead of null for a missing queue', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'getQueue').mockResolvedValue(null);

    const result = await manager.getQueueStats('ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        key: 'queue_not_found',
        message: 'Queue ghost not found',
        queueName: 'ghost',
      });
    }
  });

  it('getQueueStats returns ok stats for an existing queue', async () => {
    const { manager, boss } = makeManager();
    vi.spyOn(boss, 'getQueue').mockResolvedValue({
      name: 'email',
      deferredCount: 1,
      queuedCount: 1,
      activeCount: 1,
    } as never);

    const result = await manager.getQueueStats('email');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        name: 'email',
        deferredCount: 1,
        queuedCount: 1,
        activeCount: 1,
        totalCount: 3,
      });
    }
  });

  it('cancelJob returns ok(undefined) on success and err(job_cancel_error) with the reason on failure', async () => {
    const { manager, boss } = makeManager();
    const cancelSpy = vi.spyOn(boss, 'cancel').mockResolvedValue(undefined as never);

    const okResult = await manager.cancelJob('email', 'j1');
    expect(okResult.ok).toBe(true);
    expect(cancelSpy).toHaveBeenCalledWith('email', 'j1');

    cancelSpy.mockRejectedValue(new Error('job is active'));
    const failed = await manager.cancelJob('email', 'j1');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toEqual({
        key: 'job_cancel_error',
        message: 'job is active',
        jobId: 'j1',
        queueName: 'email',
      });
    }
  });
});

// ===========================================================================
// monitoring error factories
// ===========================================================================

describe('monitoring error factories', () => {
  it('createJobNotFoundError', () => {
    expect(createJobNotFoundError('q', 'j')).toEqual({
      key: 'job_not_found',
      message: 'Job j not found in queue q',
      jobId: 'j',
      queueName: 'q',
    });
  });

  it('createQueueNotFoundError', () => {
    expect(createQueueNotFoundError('q')).toEqual({
      key: 'queue_not_found',
      message: 'Queue q not found',
      queueName: 'q',
    });
  });

  it('createJobCancelError uses a default reason and honours an override', () => {
    expect(createJobCancelError('q', 'j').message).toBe('Failed to cancel job j in queue q');
    expect(createJobCancelError('q', 'j', 'nope').message).toBe('nope');
  });
});

// ===========================================================================
// exported schemas
// ===========================================================================

describe('exported schemas', () => {
  it('SCHEMA_SCOPED_JOB_PAYLOAD requires a non-empty scopeKey', () => {
    expect(SCHEMA_SCOPED_JOB_PAYLOAD.safeParse({ scopeKey: 't1' }).success).toBe(true);
    expect(SCHEMA_SCOPED_JOB_PAYLOAD.safeParse({ scopeKey: '' }).success).toBe(false);
    expect(SCHEMA_SCOPED_JOB_PAYLOAD.safeParse({}).success).toBe(false);
  });

  it('SCHEMA_BASE_JOB_PAYLOAD accepts any record', () => {
    expect(SCHEMA_BASE_JOB_PAYLOAD.safeParse({ anything: 1, else: 'x' }).success).toBe(true);
  });
});
