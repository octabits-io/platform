/**
 * `welcome-email` queue — `defineQueue` (`…/queue`) over pg-boss.
 *
 * `defineQueue` turns a name + payload schema + handler factory into three
 * factories (enqueuer / worker / DLQ handler) and derives the DLQ name
 * (`welcome-email-dlq`). Payloads are Zod-validated on both enqueue and dequeue;
 * a schema-invalid payload goes straight to the DLQ without burning retries,
 * since a retry cannot fix it.
 *
 * The payload extends `SCHEMA_SYSTEM_JOB_PAYLOAD`, not `SCHEMA_SCOPED_JOB_PAYLOAD`:
 * this queue is not partitioned, and the framework's guidance is to omit
 * `scopeKey` entirely rather than invent a sentinel value for it. That is also
 * why `resolveScopeKey` is not wired.
 *
 * The handler resolves its dependencies from a per-job IoC scope
 * (`createSystemScope`) and disposes it in a `finally` — the same lifetime a
 * request scope gets.
 */
import { z } from 'zod';
import { ok, err } from '@octabits-io/framework/result';
import { defineQueue, SCHEMA_SYSTEM_JOB_PAYLOAD } from '@octabits-io/framework/queue';
import type { DemoServices } from '../container.ts';

export const WELCOME_EMAIL_QUEUE = 'welcome-email';

export const SCHEMA_WELCOME_EMAIL_JOB = SCHEMA_SYSTEM_JOB_PAYLOAD.extend({
  contactId: z.uuid(),
});

export type WelcomeEmailJob = z.infer<typeof SCHEMA_WELCOME_EMAIL_JOB>;

export const welcomeEmailQueue = defineQueue<WelcomeEmailJob, DemoServices>({
  name: WELCOME_EMAIL_QUEUE,
  schema: SCHEMA_WELCOME_EMAIL_JOB,
  config: { retryLimit: 2, retryDelay: 5, expireInSeconds: 60 },
  createHandler:
    ({ createSystemScope, logger }) =>
    async (job) => {
      const scope = await createSystemScope();
      try {
        const contact = await scope.resolve('contactsService').getById(job.data.contactId);
        if (!contact.ok) {
          // A deleted contact is permanent — but the queue base only models
          // retryable vs dead-lettered, so this burns its retries first.
          return err({
            key: 'job_failed',
            message: `Contact ${job.data.contactId} not found`,
            jobId: job.id,
            queue: WELCOME_EMAIL_QUEUE,
          });
        }

        const sent = await scope.resolve('mailService').send({
          type: 'welcome',
          email: contact.value.email,
          name: contact.value.name,
        });
        if (!sent.ok) {
          return err({
            key: 'job_failed',
            message: `Failed to send welcome mail: ${sent.error.message}`,
            jobId: job.id,
            queue: WELCOME_EMAIL_QUEUE,
          });
        }

        logger.info('Welcome email job complete', { contactId: job.data.contactId });
        return ok(undefined);
      } finally {
        await scope.dispose();
      }
    },
  // The DLQ audit sink is where a real app would persist a record. No table
  // schema is baked into the queue base, so logging it is a valid wiring.
  onDlqAudit: async (_scope, record) => {
    console.warn('[dlq-audit]', JSON.stringify(record));
  },
  dlqLogFields: (data) => ({ contactId: data.contactId }),
});
