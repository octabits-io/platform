/**
 * Small showcases: `…/utils`' slugify and the `…/captcha` contract.
 *
 * The captcha service here is the **no-op** provider: every challenge auto-passes
 * and every token validates. It exists so a frontend can build the full
 * challenge → redeem → submit-with-token flow against a real contract shape with
 * nothing to install, and it logs a warning at construction so an accidentally
 * active no-op is visible. The ALTCHA proof-of-work implementation lives behind
 * `…/captcha/altcha` and is a drop-in for the same contract.
 *
 * These routes are mounted at the `/api` root rather than under a prefix of
 * their own, so the paths carry their groups (`/tools/…`, `/captcha/…`).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { errorResponses } from '@octabits-io/framework/server';
import { describeApiRoute, octApiValidator } from '@octabits-io/framework/hono/openapi';
import { slugify } from '@octabits-io/framework/utils';
import type { IoC } from '@octabits-io/framework/ioc';
import { errorJson } from '../http.ts';
import type { DemoServices } from '../container.ts';

const TAGS = ['Tools'];

export function createToolRoutes(container: IoC<DemoServices>) {
  const captcha = () => container.resolve('captcha');

  return new Hono()
    .post(
      '/tools/slugify',
      describeApiRoute({
        summary: 'Slugify a string (umlaut- and accent-aware)',
        tags: TAGS,
        responses: { 200: z.object({ slug: z.string() }), ...errorResponses(400, 429) },
      }),
      octApiValidator('json', z.object({ text: z.string().min(1).max(500) })),
      (c) => c.json({ slug: slugify(c.req.valid('json').text) }),
    )
    .get(
      '/captcha/challenge',
      describeApiRoute({
        summary: 'Create a captcha challenge',
        tags: TAGS,
        responses: {
          // The challenge is provider-specific and opaque to the client, which
          // just hands it to the matching widget — hence `z.unknown()`.
          200: z.object({ type: z.string(), challenge: z.unknown(), expires: z.number() }),
          ...errorResponses(429, 500),
        },
      }),
      async (c) => {
        const result = await captcha().createChallenge();
        if (!result.ok) return errorJson(c, result.error);
        return c.json({ type: captcha().type, challenge: result.value.challenge, expires: result.value.expires });
      },
    )
    .post(
      '/captcha/verify',
      describeApiRoute({
        summary: 'Redeem a solved challenge for a verified token',
        tags: TAGS,
        responses: { 200: z.object({ token: z.string(), expires: z.number() }), ...errorResponses(400, 429, 500) },
      }),
      octApiValidator('json', z.object({ payload: z.string().min(1) })),
      async (c) => {
        const result = await captcha().redeemChallenge(c.req.valid('json').payload);
        if (!result.ok) return errorJson(c, result.error);
        return c.json(result.value);
      },
    );
}
