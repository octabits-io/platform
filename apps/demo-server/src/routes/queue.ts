/**
 * Queue monitoring — `BossManager`'s facade over pg-boss.
 *
 * `getQueues(names?)` returns per-queue counts. Both the main queue and its
 * derived DLQ are reported: a non-zero `welcome-email-dlq` total is the signal
 * that jobs exhausted their retries.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet } from '@octabits-io/framework/elysia';
import type { IoC } from '@octabits-io/framework/ioc';
import type { DemoServices } from '../container.ts';
import { welcomeEmailQueue } from '../queues/welcome-email.ts';

const SCHEMA_QUEUE_STATS = z.object({
  name: z.string(),
  deferredCount: z.number().int(),
  queuedCount: z.number().int(),
  activeCount: z.number().int(),
  totalCount: z.number().int(),
});

export function createQueueRoutes(container: IoC<DemoServices>) {
  const watched = [welcomeEmailQueue.config.name, welcomeEmailQueue.config.dlq];

  return new Elysia({ prefix: '/queue', tags: ['Queue'] }).get(
    '/stats',
    async ({ set }) => {
      const result = await container.resolve('boss').getQueues(watched);
      if (!result.ok) return statusErrorWithSet(set, result.error);
      return { queues: result.value };
    },
    {
      response: { 200: z.object({ queues: z.array(SCHEMA_QUEUE_STATS) }), ...errorResponses(429, 500) },
      detail: { summary: 'pg-boss stats for the welcome-email queue and its DLQ' },
    },
  );
}
