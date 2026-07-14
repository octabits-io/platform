import type {
  PgBoss,
  JobWithMetadata,
  JobResult,
  SendOptions,
  UpdateQueueOptions,
} from 'pg-boss';
import type { ZodError } from 'zod';
import { ok, err } from '../result/index.ts';
import type { Result } from '../result/index.ts';
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
 * Idempotently create a pg-boss queue AND sync its queue-level settings.
 *
 * pg-boss v10+ requires a queue to exist before `send`/`work`/`schedule`; a
 * fresh database has none. In v12 `createQueue` is `INSERT ... ON CONFLICT DO
 * NOTHING` — it never throws for an existing queue, but it also never updates
 * one, so an existing queue would silently keep stale settings (e.g. an old
 * `deadLetter`) forever. `updateQueue` after `createQueue` closes that drift.
 *
 * `updateQueue` can sync every option we pass (retryLimit, retryDelay,
 * expireInSeconds, deadLetter, ...); the only immutable queue properties are
 * `policy` and `partition` (pg-boss throws if they are passed), which are
 * excluded from {@link UpdateQueueOptions} and never part of our options.
 *
 * This is the single source of truth for that ensure step so producers (the
 * queue domain) and dedicated DLQ consumers (`defineQueue`'s DLQ handler)
 * ensure queues the same way.
 *
 * @internal Not part of the package API — exported only for intra-package use.
 */
export async function ensureQueueSynced(
  boss: PgBoss,
  queueName: string,
  options?: UpdateQueueOptions,
): Promise<void> {
  await boss.createQueue(queueName, options);
  // updateQueue asserts non-empty options — skip when there is nothing to sync.
  if (options && Object.keys(options).length > 0) {
    await boss.updateQueue(queueName, options);
  }
}

/** JSON-safe one-line summary of an error cause for job failure output. */
function summarizeCause(cause: unknown): string | undefined {
  if (cause == null) return undefined;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Truncated stack (first lines only) — enough to locate the throw site. */
function summarizeStack(error: Error): string | undefined {
  if (!error.stack) return undefined;
  return error.stack.split('\n').slice(0, 6).join('\n');
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

  let workerStarted = false;

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

    // Create/sync the DLQ first (must exist before referencing it), then the
    // main queue with its deadLetter reference.
    await ensureQueueSynced(boss, dlq, { retryLimit: 0 }); // DLQ jobs should not retry
    await ensureQueueSynced(boss, name, {
      retryLimit,
      retryDelay,
      expireInSeconds,
      deadLetter: dlq,
    });
    queueCreated = true;
  }

  async function enqueue(payload: TPayload): Promise<Result<QueuedJob, EnqueueError>> {
    try {
      // Validate payload before enqueueing (fail fast)
      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return err(payloadValidationError(validation.error));
      }

      await ensureQueue();
      const jobId = await boss.send(name, validation.data, sendOptions);

      if (!jobId) {
        return err({
          key: 'queue_error',
          message: `Failed to enqueue job to ${name}`,
          queue: name,
        });
      }

      return ok({ jobId, queue: name });
    } catch (error) {
      return err({
        key: 'queue_error',
        message: error instanceof Error ? error.message : 'Unknown error enqueueing job',
        queue: name,
      });
    }
  }

  async function startWorker(
    handler: JobHandler<TPayload>,
    workerOptions?: WorkerOptions
  ): Promise<Result<void, QueueError>> {
    // Guard against double-start: pg-boss would happily register a second
    // worker for the same queue, and the first registration would leak (this
    // domain tracks a single started worker). Explicit err over a silent
    // no-op so misuse is visible to the caller; call stop() first to restart.
    if (workerStarted) {
      return err({
        key: 'queue_error',
        message: `Worker already started for queue ${name} — call stop() before starting again`,
        queue: name,
      });
    }

    try {
      await ensureQueue();

      // `perJobResults` acks each job individually — a failing job never fails
      // (and re-runs) batch-mates whose handlers already succeeded.
      // `includeMetadata` exposes the real retryCount to handlers.
      await boss.work(
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
              if (result.ok) {
                results.push({ id: job.id, status: 'completed' });
              } else {
                // Propagate the typed JobFailedError detail (cause/jobId/queue)
                // into the persisted job output — JSON-safe summaries only.
                const cause = summarizeCause(result.error.cause);
                results.push({
                  id: job.id,
                  status: 'failed',
                  output: {
                    message: result.error.message,
                    ...(result.error.jobId != null && { jobId: result.error.jobId }),
                    ...(result.error.queue != null && { queue: result.error.queue }),
                    ...(cause != null && { cause }),
                  },
                });
              }
            } catch (error) {
              const stack = error instanceof Error ? summarizeStack(error) : undefined;
              const cause = error instanceof Error ? summarizeCause(error.cause) : undefined;
              results.push({
                id: job.id,
                status: 'failed',
                output: {
                  message: error instanceof Error ? error.message : 'Unknown handler error',
                  ...(stack != null && { stack }),
                  ...(cause != null && { cause }),
                },
              });
            }
          }

          return results;
        }
      );

      workerStarted = true;
      return ok(undefined);
    } catch (error) {
      return err({
        key: 'queue_error',
        message: error instanceof Error ? error.message : 'Failed to start worker',
        queue: name,
      });
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
        return err(payloadValidationError(validation.error));
      }

      await ensureQueue();
      await boss.schedule(name, cron, validation.data, { ...sendOptions, key: scheduleName });
      return ok(undefined);
    } catch (error) {
      return err({
        key: 'queue_error',
        message: error instanceof Error ? error.message : 'Failed to schedule job',
        queue: name,
      });
    }
  }

  async function stop(): Promise<void> {
    if (!workerStarted) return;
    // pg-boss v12 `offWork(name)` matches workers by queue NAME; a worker id
    // can only be targeted via the options bag (`offWork(name, { id })`) —
    // passing an id as the first argument matches nothing and is a silent
    // no-op. We stop by name: this domain registers at most one worker
    // (double-start is guarded), so a name-scoped stop is exact here.
    await boss.offWork(name);
    workerStarted = false;
  }

  return {
    enqueue,
    startWorker,
    schedule,
    stop,
  };
}
