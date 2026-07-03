import type { PgBoss, Job, SendOptions, WorkOptions } from 'pg-boss';
import type { Result } from '@octabits-io/foundation/result';
import type {
  BaseJobPayload,
  QueueDomainConfig,
  QueueDomain,
  QueuedJob,
  QueueError,
  JobHandler,
  WorkerOptions,
  JobContext,
} from './types.ts';

export interface CreateQueueDomainDeps {
  boss: PgBoss;
}

/**
 * Factory for creating isolated queue domains.
 * Each domain handles a specific category of jobs (email, calendar, AI, etc.)
 * with its own types, handlers, and configuration.
 *
 * Benefits:
 * - Type safety: Each domain has its own payload type
 * - Runtime validation: Zod schema validates payloads from the database
 * - Isolation: Domains don't share handler logic
 * - Result pattern: All methods return Result<T, E>
 */
export function createQueueDomain<TPayload extends BaseJobPayload>(
  deps: CreateQueueDomainDeps,
  config: QueueDomainConfig<TPayload>
): QueueDomain<TPayload> {
  const { boss } = deps;
  const { name, dlq, schema, retryLimit = 3, retryDelay = 10, expireInSeconds = 60 } = config;

  let workerId: string | null = null;

  const sendOptions: SendOptions = {
    retryLimit,
    retryDelay,
    expireInSeconds,
  };

  // Create the queue with deadLetter configuration on first use
  let queueCreated = false;
  async function ensureQueue(): Promise<void> {
    if (queueCreated) return;

    // Create the DLQ first (must exist before referencing it)
    try {
      await boss.createQueue(dlq, {
        retryLimit: 0, // DLQ jobs should not retry
      });
    } catch (error) {
      // Queue may already exist, which is fine
      if (error instanceof Error && !error.message.includes('already exists')) {
        throw error;
      }
    }

    // Now create the main queue with deadLetter reference
    try {
      await boss.createQueue(name, {
        retryLimit,
        retryDelay,
        expireInSeconds,
        deadLetter: dlq,
      });
      queueCreated = true;
    } catch (error) {
      // Queue may already exist, which is fine
      if (error instanceof Error && !error.message.includes('already exists')) {
        throw error;
      }
      queueCreated = true;
    }
  }

  async function enqueue(payload: TPayload): Promise<Result<QueuedJob, QueueError>> {
    try {
      // Validate payload before enqueueing (fail fast)
      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return {
          ok: false,
          error: {
            key: 'queue_error',
            message: `Invalid payload: ${validation.error.message}`,
            queue: name,
          },
        };
      }

      await ensureQueue();
      const jobId = await boss.send(name, validation.data, sendOptions);

      if (!jobId) {
        return {
          ok: false,
          error: { key: 'queue_error', message: `Failed to enqueue job to ${name}`, queue: name },
        };
      }

      return { ok: true, value: { jobId, queue: name } };
    } catch (error) {
      return {
        ok: false,
        error: {
          key: 'queue_error',
          message: error instanceof Error ? error.message : 'Unknown error enqueueing job',
          queue: name,
        },
      };
    }
  }

  async function startWorker(
    handler: JobHandler<TPayload>,
    workerOptions?: WorkerOptions
  ): Promise<Result<void, QueueError>> {
    try {
      await ensureQueue();

      const workOpts: WorkOptions = {
        batchSize: workerOptions?.concurrency ?? 1,
        ...(workerOptions?.pollingIntervalSeconds != null && {
          pollingIntervalSeconds: workerOptions.pollingIntervalSeconds,
        }),
      };

      // pg-boss v12 work handler receives an array of jobs
      workerId = await boss.work<TPayload>(name, workOpts, async (jobs: Job<TPayload>[]) => {
        // Process each job in the batch
        for (const job of jobs) {
          // Validate payload from database (defense-in-depth)
          const validation = schema.safeParse(job.data);
          if (!validation.success) {
            // Invalid payload - don't retry, move directly to DLQ
            throw new Error(
              `Payload validation failed for job ${job.id}: ${validation.error.message}`
            );
          }

          const context: JobContext<TPayload> = {
            id: job.id,
            name: job.name,
            data: validation.data,
            retryCount: 0, // pg-boss v12 doesn't expose retry count in Job interface
          };

          const result = await handler(context);

          if (!result.ok) {
            // Throwing causes pg-boss to retry the job
            throw new Error(result.error.message);
          }
        }
      });

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: {
          key: 'queue_error',
          message: error instanceof Error ? error.message : 'Failed to start worker',
          queue: name,
        },
      };
    }
  }

  async function schedule(
    scheduleName: string,
    cron: string,
    payload: TPayload
  ): Promise<Result<void, QueueError>> {
    try {
      // Validate payload before scheduling
      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return {
          ok: false,
          error: {
            key: 'queue_error',
            message: `Invalid payload: ${validation.error.message}`,
            queue: name,
          },
        };
      }

      await ensureQueue();
      await boss.schedule(name, cron, validation.data, { ...sendOptions, key: scheduleName });
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: {
          key: 'queue_error',
          message: error instanceof Error ? error.message : 'Failed to schedule job',
          queue: name,
        },
      };
    }
  }

  async function stop(): Promise<void> {
    if (workerId) {
      await boss.offWork(workerId);
      workerId = null;
    }
  }

  return {
    enqueue,
    startWorker,
    schedule,
    stop,
  };
}
