import type { PgBoss, Job } from 'pg-boss';
import type { z } from 'zod';
import { ok, err } from '../result/index.ts';
import type { Result } from '../result/index.ts';
import type { Logger, LogAttributes } from '../logger/index.ts';
import { createQueueDomain, ensureQueueSynced } from './createQueueDomain.ts';
import type {
  BaseJobPayload,
  QueueDomainConfig,
  QueueDomain,
  QueueError,
  JobHandler,
  WorkerOptions,
} from './types.ts';

// ============================================================================
// Scope seam (IoC-erasure)
// ============================================================================

/**
 * Minimal scope interface for queue handlers and DLQ hooks.
 *
 * Deliberately narrow so it does not couple this package to any DI container:
 * it is structurally compatible with foundation's
 * `DisposableServiceResolver` (from `@octabits-io/framework/ioc`), so a
 * consumer can pass an IoC scope directly. `TServices` types `resolve`; leave
 * it as the default when the service map is erased.
 */
export interface QueueScope<TServices = Record<string, unknown>> {
  resolve<K extends keyof TServices>(key: K): TServices[K];
  dispose(): Promise<void>;
}

/**
 * Factory that creates a disposable scope for background jobs. `scopeKey` is an
 * optional partition identifier (e.g. a tenant id) for consumers whose scopes
 * are partition-bound; global/cross-partition work omits it.
 *
 * Structurally compatible with foundation's `SystemScopeFactory<T>`.
 */
export type QueueScopeFactory<TServices = Record<string, unknown>> = (
  scopeKey?: string,
) => Promise<QueueScope<TServices>>;

// ============================================================================
// DLQ audit sink
// ============================================================================

/** Fields common to every {@link DlqAuditRecord}, regardless of payload validity. */
export interface DlqAuditRecordBase {
  /** Name of the queue the job belonged to */
  queueName: string;
  /** DLQ job id (pg-boss) */
  jobId: string;
  /** Job type — mirrors {@link queueName} for single-type queues */
  jobType: string;
  /** Terminal status for a dead-lettered job */
  status: 'dead_letter';
  /** Human-readable reason the job was dead-lettered */
  errorMessage: string;
  /** ISO-8601 timestamp when the job reached the DLQ */
  completedAt: string;
  /** Partition key extracted from the payload, if any */
  scopeKey?: string;
}

/**
 * Structured record handed to the DLQ audit sink when a job is dead-lettered.
 *
 * Discriminated on `validPayload`:
 * - `validPayload: true` — the payload passed the queue's Zod schema. The job
 *   was dead-lettered by pg-boss after exhausting its retries, so
 *   `attemptCount` is the configured retry limit and `payload` is typed.
 * - `validPayload: false` — the payload failed schema validation, so the
 *   worker dead-lettered it on its first attempt without retrying
 *   (`attemptCount: 1`). No typed `payload` exists; the raw value is exposed
 *   as `rawPayload: unknown`.
 *
 * The queue base bakes in no table schema — a consumer decides how (and
 * whether) to persist this. Fields are domain-agnostic.
 */
export type DlqAuditRecord<TPayload extends BaseJobPayload> =
  | (DlqAuditRecordBase & {
      /** Payload passed the queue's Zod schema */
      validPayload: true;
      /** The schema-validated payload */
      payload: TPayload;
      /** Configured retry limit that was exhausted before dead-lettering */
      attemptCount: number;
    })
  | (DlqAuditRecordBase & {
      /** Payload failed the queue's Zod schema */
      validPayload: false;
      /** The raw, unvalidated payload as read from the DLQ job */
      rawPayload: unknown;
      /** Schema-invalid payloads are dead-lettered on the first attempt, without retry */
      attemptCount: 1;
    });

/**
 * Sink invoked for every dead-lettered job (after the optional {@link
 * DefineQueueOptions.onDlq} hook). Receives the freshly-created scope so a
 * consumer can resolve its own services (e.g. a db handle) to persist the
 * {@link DlqAuditRecord}. No table schema is baked into the queue base.
 */
export type DlqAuditSink<TPayload extends BaseJobPayload, TServices = Record<string, unknown>> = (
  scope: QueueScope<TServices>,
  record: DlqAuditRecord<TPayload>,
) => Promise<void>;

// ============================================================================
// Options + definition
// ============================================================================

export interface DefineQueueOptions<
  TPayload extends BaseJobPayload,
  TServices = Record<string, unknown>,
> {
  /** Queue name (e.g. 'email', 'booking-invoice') */
  name: string;
  /** Zod schema validating the payload (extend a `SCHEMA_*_JOB_PAYLOAD` base) */
  schema: z.ZodType<TPayload>;
  /** Handler factory — the actual business logic */
  createHandler: (deps: {
    createSystemScope: QueueScopeFactory<TServices>;
    logger: Logger;
  }) => JobHandler<TPayload>;
  /** Config overrides with sensible defaults (retryLimit 3, retryDelay 10, expireInSeconds 60) */
  config?: {
    retryLimit?: number;
    retryDelay?: number;
    expireInSeconds?: number;
  };
  /**
   * Extract a partition key from a payload. Used to bind the DLQ scope
   * (`createSystemScope(scopeKey)`) and to populate {@link DlqAuditRecord.scopeKey}.
   * Omit for unpartitioned (system/global) queues. Tenancy-agnostic: a
   * multi-tenant consumer returns `data.tenantId` here, nothing is baked in.
   */
  resolveScopeKey?: (data: TPayload) => string | undefined;
  /** Optional domain-specific DLQ hook (runs before the audit sink) */
  onDlq?: (scope: QueueScope<TServices>, job: Job<TPayload>, data: TPayload) => Promise<void>;
  /** Optional sink that persists a {@link DlqAuditRecord} for each dead-lettered job */
  onDlqAudit?: DlqAuditSink<TPayload, TServices>;
  /** Extra fields from the payload to include in the DLQ error-log context */
  dlqLogFields?: (data: TPayload) => LogAttributes;
}

/** Tuning options for the dedicated DLQ worker. */
export interface DlqWorkerOptions {
  /** How often pg-boss polls the DLQ for new jobs, in seconds (default: 30) */
  pollingIntervalSeconds?: number;
  /** Number of DLQ jobs fetched per poll (default: pg-boss's default, 1) */
  batchSize?: number;
}

export interface QueueDefinition<
  TPayload extends BaseJobPayload,
  TServices = Record<string, unknown>,
> {
  /** The resolved queue config */
  config: QueueDomainConfig<TPayload>;
  /** The Zod schema */
  schema: z.ZodType<TPayload>;
  /** Factory for a scoped enqueuer (enqueue + schedule) */
  createEnqueuer: (deps: { boss: PgBoss }) => {
    enqueue: QueueDomain<TPayload>['enqueue'];
    schedule: QueueDomain<TPayload>['schedule'];
  };
  /** Factory for the worker (needs boss + logger) */
  createWorker: (deps: { boss: PgBoss; logger: Logger }) => {
    startWorker: (
      workerDeps: { createSystemScope: QueueScopeFactory<TServices> },
      options?: WorkerOptions,
    ) => Promise<Result<void, QueueError>>;
    stop: () => Promise<void>;
  };
  /** Factory for the DLQ handler (needs boss + createSystemScope + logger) */
  createDlqHandler: (deps: {
    boss: PgBoss;
    createSystemScope: QueueScopeFactory<TServices>;
    logger: Logger;
  }) => {
    start: (options?: DlqWorkerOptions) => Promise<Result<void, QueueError>>;
    stop: () => Promise<void>;
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Declarative queue factory — a thin layer over {@link createQueueDomain}.
 *
 * Generates worker, enqueuer, and DLQ-handler factories from a name, a Zod
 * payload schema, a handler factory, and optional retry/expire config. Stays
 * tenancy-agnostic: partitioning is expressed via the generic `scopeKey` seam
 * ({@link DefineQueueOptions.resolveScopeKey}), and the dead-letter audit is
 * factored out behind an injected {@link DlqAuditSink} so no table schema is
 * baked in.
 */
export function defineQueue<
  TPayload extends BaseJobPayload,
  TServices = Record<string, unknown>,
>(options: DefineQueueOptions<TPayload, TServices>): QueueDefinition<TPayload, TServices> {
  const {
    name,
    schema,
    createHandler,
    resolveScopeKey,
    onDlq,
    onDlqAudit,
    dlqLogFields,
  } = options;

  const retryLimit = options.config?.retryLimit ?? 3;

  const queueConfig: QueueDomainConfig<TPayload> = {
    name,
    dlq: `${name}-dlq`,
    schema,
    retryLimit,
    retryDelay: options.config?.retryDelay ?? 10,
    expireInSeconds: options.config?.expireInSeconds ?? 60,
  };

  function createEnqueuer(deps: { boss: PgBoss }) {
    const domain = createQueueDomain<TPayload>({ boss: deps.boss }, queueConfig);
    return {
      enqueue: domain.enqueue,
      schedule: domain.schedule,
    };
  }

  function createWorker(deps: { boss: PgBoss; logger: Logger }) {
    const domain = createQueueDomain<TPayload>({ boss: deps.boss }, queueConfig);

    return {
      startWorker(
        workerDeps: { createSystemScope: QueueScopeFactory<TServices> },
        workerOptions?: WorkerOptions,
      ): Promise<Result<void, QueueError>> {
        const handler = createHandler({
          createSystemScope: workerDeps.createSystemScope,
          logger: deps.logger,
        });
        return domain.startWorker(handler, workerOptions);
      },
      stop: domain.stop,
    };
  }

  function createDlqHandler(deps: {
    boss: PgBoss;
    createSystemScope: QueueScopeFactory<TServices>;
    logger: Logger;
  }) {
    const { boss, createSystemScope, logger } = deps;
    let workerStarted = false;

    async function start(options?: DlqWorkerOptions): Promise<Result<void, QueueError>> {
      // Same double-start guard as the domain worker: a second registration
      // would leak the first (stop() targets the queue name once).
      if (workerStarted) {
        return err({
          key: 'queue_error',
          message: `DLQ worker already started for queue ${queueConfig.dlq} — call stop() before starting again`,
          queue: queueConfig.dlq,
        });
      }

      try {
        // A dedicated DLQ-consumer process may boot before any producer has
        // ensured the queues — on a fresh database pg-boss v10+ errors
        // 'Queue <name>-dlq does not exist' on every poll otherwise. Ensure it
        // exists first, mirroring createQueueDomain's ensure step.
        await ensureQueueSynced(boss, queueConfig.dlq, { retryLimit: 0 });

        await boss.work(
          queueConfig.dlq,
          {
            pollingIntervalSeconds: options?.pollingIntervalSeconds ?? 30,
            ...(options?.batchSize != null && { batchSize: options.batchSize }),
          },
          async (jobs: Job<TPayload>[]) => {
            for (const job of jobs) {
              // Everything that touches the raw payload runs inside this
              // per-job guard: a throw from a consumer callback (e.g.
              // resolveScopeKey on a foreign producer's null/non-object data)
              // must never reject the whole pg-boss batch, or the poison job
              // retries forever and its batch-mates go un-audited.
              try {
                const validation = schema.safeParse(job.data);
                const data = validation.success ? validation.data : (job.data as TPayload);

                // resolveScopeKey / dlqLogFields are consumer code operating on
                // an unvalidated payload — isolate each so a throw still lets us
                // log and emit the audit record with best-effort fields.
                let scopeKey: string | undefined;
                try {
                  scopeKey = resolveScopeKey?.(data);
                } catch (error) {
                  logger.error(
                    'Failed to resolve DLQ scope key',
                    error instanceof Error ? error : undefined,
                    { jobId: job.id },
                  );
                }

                let extraLogFields: LogAttributes = {};
                if (dlqLogFields) {
                  try {
                    extraLogFields = dlqLogFields(data);
                  } catch (error) {
                    logger.error(
                      'Failed to build DLQ log fields',
                      error instanceof Error ? error : undefined,
                      { jobId: job.id },
                    );
                  }
                }

                const logContext: LogAttributes = {
                  jobId: job.id,
                  scopeKey,
                  validPayload: validation.success,
                  ...extraLogFields,
                };

                logger.error(`${name} job moved to dead letter queue`, undefined, logContext);

                const scope = await createSystemScope(scopeKey);
                try {
                  // Domain-specific DLQ hook (e.g. saga compensation, step cleanup).
                  if (onDlq) {
                    await onDlq(scope, job, data);
                  }

                  // Audit sink — the consumer decides how/whether to persist.
                  if (onDlqAudit) {
                    const base: DlqAuditRecordBase = {
                      queueName: name,
                      jobId: job.id,
                      jobType: name,
                      status: 'dead_letter',
                      errorMessage: validation.success
                        ? 'Exhausted all retry attempts'
                        : 'Payload failed schema validation; dead-lettered without retry',
                      completedAt: new Date().toISOString(),
                      ...(scopeKey != null && { scopeKey }),
                    };
                    // Honest attempt accounting: retry-exhausted jobs report
                    // the configured retry limit; schema-invalid payloads are
                    // dead-lettered by the worker on their FIRST attempt.
                    const record: DlqAuditRecord<TPayload> = validation.success
                      ? {
                          ...base,
                          validPayload: true,
                          payload: validation.data,
                          attemptCount: retryLimit,
                        }
                      : {
                          ...base,
                          validPayload: false,
                          rawPayload: job.data,
                          attemptCount: 1,
                        };
                    await onDlqAudit(scope, record);
                  }
                } catch (error) {
                  logger.error(
                    'Failed to run DLQ audit sink',
                    error instanceof Error ? error : undefined,
                    { jobId: job.id },
                  );
                } finally {
                  await scope.dispose();
                }
              } catch (error) {
                // Last-resort guard (e.g. createSystemScope threw): keep the
                // batch alive so healthy jobs are still processed and acked.
                logger.error(
                  `Failed to process ${name} dead-letter job`,
                  error instanceof Error ? error : undefined,
                  { jobId: job.id },
                );
              }
            }
          },
        );

        workerStarted = true;
        return ok(undefined);
      } catch (error) {
        return err({
          key: 'queue_error',
          message:
            error instanceof Error ? error.message : `Failed to start DLQ handler for ${name}`,
          queue: queueConfig.dlq,
        });
      }
    }

    async function stop(): Promise<void> {
      if (!workerStarted) return;
      // pg-boss v12 `offWork(name)` matches workers by queue NAME; passing a
      // worker id as the first argument matches nothing (a silent no-op) —
      // ids only work via `offWork(name, { id })`. Name-scoped stop is exact
      // here since this handler registers a single worker (guarded above).
      await boss.offWork(queueConfig.dlq);
      workerStarted = false;
    }

    return { start, stop };
  }

  return {
    config: queueConfig,
    schema,
    createEnqueuer,
    createWorker,
    createDlqHandler,
  };
}
