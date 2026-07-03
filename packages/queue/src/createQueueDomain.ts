import type { PgBoss, JobWithMetadata, JobResult, SendOptions } from 'pg-boss';
import type { ZodError } from 'zod';
import type { Result } from '@octabits-io/foundation/result';
import type {
  BaseJobPayload,
  QueueDomainConfig,
  QueueDomain,
  QueuedJob,
  QueueError,
  EnqueueError,
  PayloadValidationError,
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
 * - Per-job acking: a failing job never fails or retries its batch-mates
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

  function payloadValidationError(error: ZodError, jobId?: string): PayloadValidationError {
    return {
      key: 'payload_validation_error',
      message: `Invalid payload: ${error.message}`,
      queue: name,
      ...(jobId != null && { jobId }),
      issues: error.issues,
    };
  }

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

  async function enqueue(payload: TPayload): Promise<Result<QueuedJob, EnqueueError>> {
    try {
      // Validate payload before enqueueing (fail fast)
      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return { ok: false, error: payloadValidationError(validation.error) };
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

      // `perJobResults` acks each job individually — a failing job never fails
      // (and re-runs) batch-mates whose handlers already succeeded.
      // `includeMetadata` exposes the real retryCount to handlers.
      workerId = await boss.work(
        name,
        {
          batchSize: workerOptions?.batchSize ?? 1,
          ...(workerOptions?.pollingIntervalSeconds != null && {
            pollingIntervalSeconds: workerOptions.pollingIntervalSeconds,
          }),
          perJobResults: true,
          includeMetadata: true,
        },
        async (jobs: JobWithMetadata<TPayload>[]): Promise<JobResult[]> => {
          const results: JobResult[] = [];

          for (const job of jobs) {
            // Validate payload from database (defense-in-depth). Retrying an
            // invalid payload can't help — route it straight to the DLQ.
            const validation = schema.safeParse(job.data);
            if (!validation.success) {
              results.push({
                id: job.id,
                status: 'deadletter',
                output: { message: `Payload validation failed: ${validation.error.message}` },
              });
              continue;
            }

            const context: JobContext<TPayload> = {
              id: job.id,
              name: job.name,
              data: validation.data,
              retryCount: job.retryCount,
            };

            try {
              const result = await handler(context);
              results.push(
                result.ok
                  ? { id: job.id, status: 'completed' }
                  : { id: job.id, status: 'failed', output: { message: result.error.message } }
              );
            } catch (error) {
              results.push({
                id: job.id,
                status: 'failed',
                output: {
                  message: error instanceof Error ? error.message : 'Unknown handler error',
                },
              });
            }
          }

          return results;
        }
      );

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
  ): Promise<Result<void, EnqueueError>> {
    try {
      // Validate payload before scheduling
      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return { ok: false, error: payloadValidationError(validation.error) };
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
