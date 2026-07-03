import { PgBoss } from 'pg-boss';
import type { Logger } from '@octabits-io/foundation/logger';
import type { JobDetails, QueueStats } from './monitoring.ts';

export interface BossManagerConfig {
  /** PostgreSQL connection string */
  connectionString: string;
  /** Logger instance (injected — structural, no runtime coupling) */
  logger: Logger;
  /** Schema name for pg-boss tables (default: 'pgboss') */
  schema?: string;
}

export interface BossManager {
  /** Get the pg-boss instance */
  getBoss(): PgBoss;
  /** Start pg-boss (creates tables, starts maintenance) */
  start(): Promise<void>;
  /** Stop pg-boss gracefully */
  stop(): Promise<void>;
  /** Get a job by ID from a specific queue */
  getJobById(queueName: string, jobId: string): Promise<JobDetails | null>;
  /** Get stats for multiple queues */
  getQueues(names?: string[]): Promise<QueueStats[]>;
  /** Get stats for a single queue */
  getQueueStats(queueName: string): Promise<QueueStats | null>;
  /** Cancel a job */
  cancelJob(queueName: string, jobId: string): Promise<boolean>;
}

/**
 * Creates a BossManager for managing the pg-boss lifecycle.
 * Provides a shared pg-boss instance for all queue domains.
 *
 * No domain coupling — the logger is injected by the caller.
 */
export function createBossManager(config: BossManagerConfig): BossManager {
  const { connectionString, logger, schema = 'pgboss' } = config;

  const boss = new PgBoss({
    connectionString,
    schema,
    // Maintenance interval (cleanup, archive, etc.)
    maintenanceIntervalSeconds: 60,
    // Monitor interval for queue states
    monitorIntervalSeconds: 60,
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

  async function getJobById(queueName: string, jobId: string): Promise<JobDetails | null> {
    const job = await boss.getJobById(queueName, jobId);
    if (!job) {
      return null;
    }

    return {
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
    };
  }

  async function getQueues(names?: string[]): Promise<QueueStats[]> {
    const queues = await boss.getQueues();
    const filtered = names ? queues.filter(q => names.includes(q.name)) : queues;
    return filtered.map(q => ({
      name: q.name,
      deferredCount: q.deferredCount,
      queuedCount: q.queuedCount,
      activeCount: q.activeCount,
      totalCount: q.deferredCount + q.queuedCount + q.activeCount,
    }));
  }

  async function getQueueStats(queueName: string): Promise<QueueStats | null> {
    const queue = await boss.getQueue(queueName);
    if (!queue) {
      return null;
    }

    return {
      name: queue.name,
      deferredCount: queue.deferredCount,
      queuedCount: queue.queuedCount,
      activeCount: queue.activeCount,
      totalCount: queue.deferredCount + queue.queuedCount + queue.activeCount,
    };
  }

  async function cancelJob(queueName: string, jobId: string): Promise<boolean> {
    // pg-boss cancel takes queue name and job id
    // Returns a CommandResponse which is truthy on success
    try {
      await boss.cancel(queueName, jobId);
      return true;
    } catch {
      return false;
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
