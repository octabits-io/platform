/**
 * Small showcases: `…/utils`' slugify and the `…/captcha` contract.
 *
 * The captcha service here is the **no-op** provider: every challenge auto-passes
 * and every token validates. It exists so a frontend can build the full
 * challenge → redeem → submit-with-token flow against a real contract shape with
 * nothing to install, and it logs a warning at construction so an accidentally
 * active no-op is visible. The ALTCHA proof-of-work implementation lives behind
 * `…/captcha/altcha` and is a drop-in for the same contract.
 */
import { Elysia } from 'elysia';
import { z } from 'zod';
import { errorResponses, statusErrorWithSet } from '@octabits-io/framework/elysia';
import { slugify } from '@octabits-io/framework/utils';
import type { IoC } from '@octabits-io/framework/ioc';
import type { DemoServices } from '../container.ts';

export function createToolRoutes(container: IoC<DemoServices>) {
  const captcha = () => container.resolve('captcha');

  return new Elysia({ tags: ['Tools'] })
    .post(
      '/tools/slugify',
      ({ body }) => ({ slug: slugify(body.text) }),
      {
        body: z.object({ text: z.string().min(1).max(500) }),
        response: { 200: z.object({ slug: z.string() }), ...errorResponses(400, 429) },
        detail: { summary: 'Slugify a string (umlaut- and accent-aware)' },
      },
    )
    .get(
      '/captcha/challenge',
      async ({ set }) => {
        const result = await captcha().createChallenge();
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return { type: captcha().type, challenge: result.value.challenge, expires: result.value.expires };
      },
      {
        response: {
          // The challenge is provider-specific and opaque to the client, which
          // just hands it to the matching widget — hence `z.unknown()`.
          200: z.object({ type: z.string(), challenge: z.unknown(), expires: z.number() }),
          ...errorResponses(429, 500),
        },
        detail: { summary: 'Create a captcha challenge' },
      },
    )
    .post(
      '/captcha/verify',
      async ({ body, set }) => {
        const result = await captcha().redeemChallenge(body.payload);
        if (!result.ok) return statusErrorWithSet(set, result.error);
        return result.value;
      },
      {
        body: z.object({ payload: z.string().min(1) }),
        response: {
          200: z.object({ token: z.string(), expires: z.number() }),
          ...errorResponses(400, 429, 500),
        },
        detail: { summary: 'Redeem a solved challenge for a verified token' },
      },
    );
}
