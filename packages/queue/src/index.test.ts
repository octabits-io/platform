import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { PgBoss } from 'pg-boss';
import {
  createQueueDomain,
  createBossManager,
  createJobNotFoundError,
  createQueueNotFoundError,
  createJobCancelError,
  SCHEMA_TENANT_JOB_PAYLOAD,
  SCHEMA_BASE_JOB_PAYLOAD,
} from './index.ts';

// ---------------------------------------------------------------------------
// Test payload + schema
// ---------------------------------------------------------------------------

const SCHEMA_TEST_JOB = SCHEMA_TENANT_JOB_PAYLOAD.extend({
  to: z.string().email(),
});
type TestJob = z.infer<typeof SCHEMA_TEST_JOB>;

const validPayload: TestJob = { tenantId: 't1', to: 'a@b.com' };

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

  it('rejects an invalid payload without touching pg-boss (fail fast)', async () => {
    const domain = domainWith(boss);
    // Missing tenantId + bad email
    const result = await domain.enqueue({ to: 'not-an-email' } as unknown as TestJob);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('queue_error');
      expect(result.error.queue).toBe('email');
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

describe('createQueueDomain.startWorker', () => {
  it('wires a batch worker and validates each job before invoking the handler', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });

    const result = await domain.startWorker(handler, { concurrency: 5 });
    expect(result.ok).toBe(true);
    expect(boss.work).toHaveBeenCalledWith(
      'email',
      expect.objectContaining({ batchSize: 5 }),
      expect.any(Function)
    );

    // Drive the registered batch handler with one valid job
    const batchHandler = boss.work.mock.calls[0]![2] as (jobs: unknown[]) => Promise<void>;
    await batchHandler([{ id: 'j1', name: 'email', data: validPayload }]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j1', name: 'email', data: validPayload })
    );
  });

  it('throws inside the batch handler on invalid payload (routes to DLQ)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as (jobs: unknown[]) => Promise<void>;
    await expect(
      batchHandler([{ id: 'bad', name: 'email', data: { to: 'nope' } }])
    ).rejects.toThrow(/validation failed/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws inside the batch handler when the handler returns an error Result (triggers retry)', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);
    const handler = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { key: 'job_failed', message: 'boom' } });
    await domain.startWorker(handler);

    const batchHandler = boss.work.mock.calls[0]![2] as (jobs: unknown[]) => Promise<void>;
    await expect(
      batchHandler([{ id: 'j1', name: 'email', data: validPayload }])
    ).rejects.toThrow('boom');
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
      tenantId: '',
      to: 'x',
    } as unknown as TestJob);

    expect(result.ok).toBe(false);
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it('stops the worker only when one is running', async () => {
    const boss = createMockBoss();
    const domain = domainWith(boss);

    // No worker started yet — stop is a no-op
    await domain.stop();
    expect(boss.offWork).not.toHaveBeenCalled();

    await domain.startWorker(vi.fn().mockResolvedValue({ ok: true, value: undefined }));
    await domain.stop();
    expect(boss.offWork).toHaveBeenCalledWith('worker-1');
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
  it('SCHEMA_TENANT_JOB_PAYLOAD requires a non-empty tenantId', () => {
    expect(SCHEMA_TENANT_JOB_PAYLOAD.safeParse({ tenantId: 't1' }).success).toBe(true);
    expect(SCHEMA_TENANT_JOB_PAYLOAD.safeParse({ tenantId: '' }).success).toBe(false);
    expect(SCHEMA_TENANT_JOB_PAYLOAD.safeParse({}).success).toBe(false);
  });

  it('SCHEMA_BASE_JOB_PAYLOAD accepts any record', () => {
    expect(SCHEMA_BASE_JOB_PAYLOAD.safeParse({ anything: 1, else: 'x' }).success).toBe(true);
  });
});
