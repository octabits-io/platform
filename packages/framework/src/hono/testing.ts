/**
 * Adapter onto the framework-agnostic test harness.
 * `../server/testing`'s `testRequest` drives anything
 * structural (`{ handle(Request): Promise<Response> }`); a Hono app exposes
 * `fetch` instead of `handle`, so this one-liner is the entire bridge.
 */
import type { Hono } from 'hono';
import type { Env } from 'hono';
import type { TestableApp } from '../server/testing';

/** Wrap a Hono app in the structural `TestableApp` contract. */
export function testableHonoApp<E extends Env>(app: Hono<E>): TestableApp {
  return { handle: (request: Request) => Promise.resolve(app.fetch(request)) };
}
