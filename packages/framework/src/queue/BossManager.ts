import { PgBoss } from 'pg-boss';
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
}

export interface BossManager {
  /** Get the pg-boss instance */
  getBoss(): PgBoss;
  /** Start pg-boss (creates tables, starts maintenance) */
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
  } = config;

  const boss = new PgBoss({
    connectionString,
    schema,
    maintenanceIntervalSeconds,
    monitorIntervalSeconds,
  });

  // Log pg-boss events
  boss.on('error', (error: Error) => {
    logger.error('pg-boss error', error);
  });

  async function start(): Promise<void> {
    logger.info('Starting pg-boss...');
    await boss.start();
    logger.info('pg-boss started');
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
