/**
 * Integration tests against a real Postgres + pg-boss (Docker required).
 *
 * Covers the behaviors mocks can't verify: DLQ routing, per-job batch acking,
 * retry counting, and queue creation idempotency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { z } from 'zod';
import type { Logger } from '@octabits-io/foundation/logger';
import { createBossManager, createQueueDomain, type BossManager } from './index.ts';

const SCHEMA_JOB = z.object({ ref: z.string(), fail: z.boolean().default(false) });
type TestJob = z.infer<typeof SCHEMA_JOB>;

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

let container: StartedPostgreSqlContainer;
let manager: BossManager;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  manager = createBossManager({
    connectionString: container.getConnectionUri(),
    logger: silentLogger,
  });
  await manager.start();
});

afterAll(async () => {
  await manager?.stop();
  await container?.stop();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('waitFor timed out');
}

function domain(name: string, opts?: { retryLimit?: number; retryDelay?: number }) {
  return createQueueDomain<TestJob>(
    { boss: manager.getBoss() },
    { name, dlq: `${name}-dlq`, schema: SCHEMA_JOB, ...opts }
  );
}

describe('queue domain against real pg-boss', () => {
  it('processes an enqueued job exactly once, with retryCount 0 on the first attempt', async () => {
    const seen: Array<{ ref: string; retryCount: number }> = [];
    const d = domain('q-basic');
    await d.startWorker(
      async (job) => {
        seen.push({ ref: job.data.ref, retryCount: job.retryCount });
        return { ok: true, value: undefined };
      },
      { pollingIntervalSeconds: 0.5 }
    );

    const res = await d.enqueue({ ref: 'a', fail: false });
    expect(res.ok).toBe(true);

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ ref: 'a', retryCount: 0 });

    // Settle one extra poll: the job must not run again.
    await new Promise((r) => setTimeout(r, 1200));
    expect(seen).toHaveLength(1);

    await d.stop();
  });

  it('acks per job: one failing job in a batch neither fails nor re-runs its batch-mates', async () => {
    const calls: string[] = [];
    const d = domain('q-batch', { retryLimit: 0, retryDelay: 0 });

    // Enqueue the full batch before the worker starts so one fetch grabs all three.
    await d.enqueue({ ref: 'ok1', fail: false });
    await d.enqueue({ ref: 'boom', fail: true });
    await d.enqueue({ ref: 'ok2', fail: false });

    await d.startWorker(
      async (job) => {
        calls.push(job.data.ref);
        return job.data.fail
          ? { ok: false, error: { key: 'job_failed', message: 'boom' } }
          : { ok: true, value: undefined };
      },
      { batchSize: 3, pollingIntervalSeconds: 0.5 }
    );

    // The failing job (retryLimit 0) must land in the DLQ…
    await waitFor(async () => (await manager.getBoss().findJobs('q-batch-dlq')).length >= 1);
    // …and the succeeded batch-mates must have run exactly once (no batch-wide retry).
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls.filter((c) => c === 'ok1')).toHaveLength(1);
    expect(calls.filter((c) => c === 'ok2')).toHaveLength(1);

    await d.stop();
  });

  it('routes a schema-invalid payload straight to the DLQ without invoking the handler', async () => {
    const calls: string[] = [];
    const d = domain('q-invalid', { retryLimit: 2, retryDelay: 0 });

    await d.enqueue({ ref: 'seed', fail: false });
    // Bypass enqueue-side validation to simulate a corrupt row.
    await manager.getBoss().send('q-invalid', { totally: 'wrong' }, {});

    await d.startWorker(
      async (job) => {
        calls.push(job.data.ref);
        return { ok: true, value: undefined };
      },
      { batchSize: 2, pollingIntervalSeconds: 0.5 }
    );

    await waitFor(async () => (await manager.getBoss().findJobs('q-invalid-dlq')).length >= 1);
    expect(calls).toEqual(['seed']);

    await d.stop();
  });

  it('retries a failing job with a real retryCount, then dead-letters it on exhaustion', async () => {
    const attempts: number[] = [];
    const d = domain('q-retry', { retryLimit: 2, retryDelay: 0 });

    await d.enqueue({ ref: 'r', fail: true });
    await d.startWorker(
      async (job) => {
        attempts.push(job.retryCount);
        return { ok: false, error: { key: 'job_failed', message: 'always' } };
      },
      { pollingIntervalSeconds: 0.5 }
    );

    await waitFor(async () => (await manager.getBoss().findJobs('q-retry-dlq')).length >= 1, 30_000);
    expect(attempts).toEqual([0, 1, 2]);

    await d.stop();
  });

  it('stop() actually detaches the worker: jobs enqueued afterwards stay unprocessed', async () => {
    // Regression for the offWork(workerId) bug: pg-boss v12 offWork matches by
    // queue NAME, so passing the worker id was a silent no-op and the worker
    // kept polling forever.
    const seen: string[] = [];
    const d = domain('q-stop');
    await d.startWorker(
      async (job) => {
        seen.push(job.data.ref);
        return { ok: true, value: undefined };
      },
      { pollingIntervalSeconds: 0.5 }
    );

    await d.enqueue({ ref: 'before-stop', fail: false });
    await waitFor(() => seen.length === 1);

    await d.stop();
    await d.enqueue({ ref: 'after-stop', fail: false });

    // Give a stopped worker ample polls — nothing new may be processed.
    await new Promise((r) => setTimeout(r, 2000));
    expect(seen).toEqual(['before-stop']);
  });

  it('exposes queue stats and job lookup through the BossManager facade', async () => {
    const d = domain('q-stats');
    const res = await d.enqueue({ ref: 's', fail: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Counts refresh on pg-boss's monitor sweep (monitorIntervalSeconds), so
    // only the shape is deterministic here — not the freshly-enqueued count.
    const stats = await manager.getQueueStats('q-stats');
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.name).toBe('q-stats');
      expect(typeof stats.value.queuedCount).toBe('number');
      expect(typeof stats.value.totalCount).toBe('number');
    }

    const job = await manager.getJobById('q-stats', res.value.jobId);
    expect(job.ok).toBe(true);
    if (job.ok) {
      expect(job.value.id).toBe(res.value.jobId);
      expect(job.value.data).toEqual({ ref: 's', fail: false });
    }

    // Missing lookups surface as typed errors, not nulls.
    const missing = await manager.getQueueStats('q-missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.key).toBe('queue_not_found');
  });
});
