/**
 * Zod validation for the event envelope. The publisher runs every emitted
 * event through this before it touches the store — an envelope that fails
 * here is a programming error at the emit site, caught in development rather
 * than as a malformed row or an undecodable notification.
 */
import { z } from 'zod';

export const EVENT_ACTOR_SCHEMA = z.object({
  type: z.string().min(1),
  id: z.string().optional(),
  name: z.string().optional(),
});

export const EVENT_AUDIENCE_SCHEMA = z.object({
  users: z.array(z.string().min(1)).optional(),
  permission: z.unknown().optional(),
});

export const EVENT_ENVELOPE_SCHEMA = z.object({
  id: z.string().min(1),
  seq: z.number().int().positive().optional(),
  type: z.string().min(1),
  scopeKey: z.string().min(1),
  at: z.string().min(1),
  lane: z.enum(['durable', 'ephemeral']),
  data: z.unknown(),
  actor: EVENT_ACTOR_SCHEMA.optional(),
  audience: EVENT_AUDIENCE_SCHEMA.optional(),
  resources: z.array(z.string().min(1)).optional(),
});
