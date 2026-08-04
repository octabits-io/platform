/**
 * The pre-compiled `hc` client — `@octabits-io/demo-server/client`.
 *
 * This is Hono's documented mitigation for the one real cost of `hc`: the
 * client type is computed by walking the app's accumulated route schema, and
 * that walk is re-done **at every import site**. On an app this size it is
 * invisible; on a large one it is the difference between a snappy editor and a
 * stalled one. Instantiating `hc<App>` **once**, here, and exporting the
 * resulting *value type* means every consumer imports a finished type instead
 * of re-deriving it.
 *
 * The parallel to Eden: `createTreatyClientFactory<App>()` did its own
 * inference per call site too — the difference is that `hc` gives you a
 * documented place to pay for it once.
 *
 * Caveat worth knowing before copying this into a built package: demo-server
 * ships TypeScript **sources**, so the consumer's compiler still derives the
 * type from this file rather than reading it out of a `.d.ts`. The win here is
 * "once per project" rather than "never" — a published package that emits
 * declarations gets the full benefit.
 */
import { hc } from 'hono/client';
import type { App } from './app.ts';

// Instantiated once purely to capture the type. The URL is irrelevant — this
// value is never called; `hcWithType` builds the real client.
const client = hc<App>('');

/** The fully-resolved client type. `typeof client` is the whole point. */
export type DemoClient = typeof client;

/** Build a typed client without re-deriving `hc<App>` at the call site. */
export const hcWithType = (...args: Parameters<typeof hc<App>>): DemoClient => hc<App>(...args);
