import { PgBoss } from 'pg-boss';
import type { ConstructorOptions } from 'pg-boss';
import { ok, err } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import type { Logger } from '../logger/index.ts';
import {
  createJobNotFoundError,
  createQueueNotFoundError,
  createJobCancelError,
} from './monitoring.ts';
import type {
  JobDetails,
  QueueStats,
  JobNotFoundError,
  QueueNotFoundError,
  JobCancelError,
} from './monitoring.ts';
import type { QueueError } from './types.ts';

export interface BossManagerConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Logger instance (injected — structural, no runtime coupling) */
  logger: Logger;
  /** Schema name for pg-boss tables (default: 'pgboss') */
  schema?: string;
  /** Maintenance interval (cleanup, archive, …) in seconds (default: 60) */
  maintenanceIntervalSeconds?: number;
  /** Queue-state monitor interval in seconds (default: 60) */
  monitorIntervalSeconds?: number;
  /**
   * What this process does with the queue (default: `'full'`).
   *
   * - `'full'` — the process consumes and/or is long-lived, so it also owns
   *   schema migration, maintenance supervision and the cron timekeeper.
   * - `'producer'` — the process only *sends*. See {@link PRODUCER_OPTIONS}.
   *
   * `send()` needs a *started* boss either way: pg-boss owns its own pool and
   * opens it in `start()`. The role only decides how much of pg-boss's
   * background machinery that start brings up with it.
   */
  role?: 'full' | 'producer';
  /**
   * Index-bloat rebuilds during maintenance (pg-boss >= 12.29). Omitted by
   * default, which keeps pg-boss's own default: rebuild an index that fails a
   * density check with `REINDEX INDEX CONCURRENTLY`.
   *
   * Pass `false` to switch rebuilds off — bloat *detection* and the
   * `index_bloat` warning are unaffected, so an operator can still run the
   * statements from `getReindexCommands()` in a window they choose — or an
   * options object to tune the thresholds.
   *
   * Only a `role: 'full'` process ever acts on this: a producer supervises
   * nothing. Note that every non-producer process is a candidate, not just the
   * one running workers — pg-boss coordinates the pass cluster-wide through
   * `version.reindex_on`, so the interval is shared, but any full-role process
   * may be the one that performs it.
   */
  reindex?: ConstructorOptions['reindex'];
  /**
   * How often the index-bloat check runs, in seconds (pg-boss default: 86400).
   * Must be >= 1 second and at most 24 hours.
   */
  reindexIntervalSeconds?: number;
}

/**
 * pg-boss options for a send-only process — one that enqueues and exits (a
 * cron pod, a one-shot CLI) or that never runs a worker.
 *
 * Every flag here disables *background* work that only a consumer or a
 * long-lived process should be doing:
 *
 * - `supervise: false` — no maintenance/archive sweeps and no queue monitor.
 *   Those are cluster-wide chores; a pod that lives ten seconds contributes
 *   nothing but load, and the long-running processes already do them.
 * - `schedule: false` — no cron timekeeper. A producer does not own schedules.
 * - `migrate: false` — the decisive one. With `migrate` on, *every* start is a
 *   potential DDL run; ephemeral producers would race the long-lived processes
 *   over the same schema on every tick. Off, pg-boss instead *checks* the
 *   installation and throws `pg-boss is not installed` / `pg-boss database
 *   requires migrations` — which is what a producer wants: it never migrates,
 *   and it fails loudly rather than proceeding against a schema it cannot use.
 *
 * Consequence worth stating plainly: a `'producer'` process cannot bootstrap a
 * fresh database. Something with `role: 'full'` must have started at least once
 * first.
 */
const PRODUCER_OPTIONS = {
  supervise: false,
  schedule: false,
  migrate: false,
  // A producer runs no workers, so nothing here would act on a NOTIFY — skip
  // the dedicated LISTEN connection. The NOTIFY itself is still *emitted* by a
  // producer's sends (it is decided per queue, see `notify` in
  // `QueueDomainConfig`); only the listening half is a consumer concern.
  useListenNotify: false,
} as const satisfies Partial<ConstructorOptions>;

export interface BossManager {
  /** Get the pg-boss instance */
  getBoss(): PgBoss;
  /** Start pg-boss — opens the pool, and under `role: 'full'` also creates/migrates tables and starts maintenance */
  start(): Promise<void>;
  /** Stop pg-boss gracefully */
  stop(): Promise<void>;
  /** Get a job by ID from a specific queue */
  getJobById(
    queueName: string,
    jobId: string
  ): Promise<Result<JobDetails, JobNotFoundError | QueueError>>;
  /** Get stats for multiple queues */
  getQueues(names?: string[]): Promise<Result<QueueStats[], QueueError>>;
  /** Get stats for a single queue */
  getQueueStats(
    queueName: string
  ): Promise<Result<QueueStats, QueueNotFoundError | QueueError>>;
  /** Cancel a job */
  cancelJob(queueName: string, jobId: string): Promise<Result<void, JobCancelError>>;
}

/**
 * Creates a BossManager for managing the pg-boss lifecycle.
 * Provides a shared pg-boss instance for all queue domains.
 *
 * No domain coupling — the logger is injected by the caller.
 */
export function createBossManager(config: BossManagerConfig): BossManager {
  const {
    connectionString,
    logger,
    schema = 'pgboss',
    maintenanceIntervalSeconds = 60,
    monitorIntervalSeconds = 60,
    role = 'full',
    reindex,
    reindexIntervalSeconds,
  } = config;

  const boss = new PgBoss({
    connectionString,
    schema,
    // Harmless under `'producer'` — the subsystems these tune are never
    // started — but kept unconditional so the two roles differ in exactly the
    // flags PRODUCER_OPTIONS names and nothing else.
    maintenanceIntervalSeconds,
    monitorIntervalSeconds,
    // Wake workers on a NOTIFY instead of waiting out their poll interval.
    // Doubly opt-in in pg-boss: this instance flag AND `notify: true` on the
    // queue (a `QueueDomainConfig` option). Polling stays on as the correctness
    // floor; when the listener cannot be established (PgBouncer transaction
    // pooling, a backend without LISTEN) pg-boss emits a `warning` and keeps
    // polling only. Needs a session-pinned connection — hand pg-boss the
    // direct database URL, never the pooler.
    useListenNotify: true,
    // Spread conditionally, never as `reindex: undefined`: pg-boss validates
    // these two with `'key' in config`, so an explicitly-undefined key is not
    // the same as an absent one — it fails the config assert instead of
    // falling back to the default.
    ...(reindex !== undefined ? { reindex } : {}),
    ...(reindexIntervalSeconds !== undefined ? { reindexIntervalSeconds } : {}),
    ...(role === 'producer' ? PRODUCER_OPTIONS : {}),
  });

  // Log pg-boss events
  boss.on('error', (error: Error) => {
    logger.error('pg-boss error', error);
  });
  // pg-boss degrades silently on a `warning` — most importantly when the
  // LISTEN/NOTIFY listener cannot be established and it falls back to polling
  // only. Without this line that fallback is invisible in production.
  boss.on('warning', (warning: { type?: string; message?: string }) => {
    logger.warn(`pg-boss warning: ${warning.message ?? 'unknown'}`, { type: warning.type });
  });

  async function start(): Promise<void> {
    logger.info('Starting pg-boss...', { role });
    try {
      await boss.start();
    } catch (error) {
      // Under `'producer'` the start is a *check*, so pg-boss's own message
      // ("pg-boss is not installed") describes a state this process is not
      // allowed to fix — and reads like a bug rather than a deployment order
      // problem. Say what the caller has to do instead, and keep the original
      // as the `cause`.
      if (role === 'producer' && error instanceof Error) {
        throw new Error(
          `pg-boss cannot start with role 'producer': ${error.message}. ` +
            "A producer never installs or migrates the schema — run a process with role 'full' " +
            'against this database first.',
          { cause: error },
        );
      }
      throw error;
    }
    logger.info('pg-boss started', { role });
  }

  async function stop(): Promise<void> {
    logger.info('Stopping pg-boss...');
    await boss.stop({ graceful: true, timeout: 30000 });
    logger.info('pg-boss stopped');
  }

  /** Map an unexpected (e.g. connection-level) throw to a queue_error Result. */
  function queueError(queueName: string, error: unknown, fallback: string): QueueError {
    return {
      key: 'queue_error',
      message: error instanceof Error ? error.message : fallback,
      queue: queueName,
    };
  }

  async function getJobById(
    queueName: string,
    jobId: string
  ): Promise<Result<JobDetails, JobNotFoundError | QueueError>> {
    try {
      const [job] = await boss.findJobs(queueName, { id: jobId });
      if (!job) {
        return err(createJobNotFoundError(queueName, jobId));
      }

      return ok({
        id: job.id,
        name: job.name,
        data: job.data as Record<string, unknown>,
        state: job.state,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        startedOn: job.startedOn?.toISOString() ?? null,
        completedOn: job.completedOn?.toISOString() ?? null,
        createdOn: job.createdOn.toISOString(),
        expireInSeconds: job.expireInSeconds ?? 0,
        output: job.output as Record<string, unknown> | null,
      });
    } catch (error) {
      return err(queueError(queueName, error, `Failed to look up job ${jobId}`));
    }
  }

  async function getQueues(names?: string[]): Promise<Result<QueueStats[], QueueError>> {
    try {
      const queues = await boss.getQueues();
      const filtered = names ? queues.filter(q => names.includes(q.name)) : queues;
      return ok(
        filtered.map(q => ({
          name: q.name,
          deferredCount: q.deferredCount,
          queuedCount: q.queuedCount,
          activeCount: q.activeCount,
          totalCount: q.deferredCount + q.queuedCount + q.activeCount,
        }))
      );
    } catch (error) {
      return err({
        key: 'queue_error',
        message: error instanceof Error ? error.message : 'Failed to list queues',
      });
    }
  }

  async function getQueueStats(
    queueName: string
  ): Promise<Result<QueueStats, QueueNotFoundError | QueueError>> {
    try {
      const queue = await boss.getQueue(queueName);
      if (!queue) {
        return err(createQueueNotFoundError(queueName));
      }

      return ok({
        name: queue.name,
        deferredCount: queue.deferredCount,
        queuedCount: queue.queuedCount,
        activeCount: queue.activeCount,
        totalCount: queue.deferredCount + queue.queuedCount + queue.activeCount,
      });
    } catch (error) {
      return err(queueError(queueName, error, `Failed to get stats for queue ${queueName}`));
    }
  }

  async function cancelJob(
    queueName: string,
    jobId: string
  ): Promise<Result<void, JobCancelError>> {
    try {
      await boss.cancel(queueName, jobId);
      return ok(undefined);
    } catch (error) {
      logger.warn('Failed to cancel job', {
        queue: queueName,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return err(
        createJobCancelError(
          queueName,
          jobId,
          error instanceof Error ? error.message : undefined
        )
      );
    }
  }

  return {
    getBoss: () => boss,
    start,
    stop,
    getJobById,
    getQueues,
    getQueueStats,
    cancelJob,
  };
}
