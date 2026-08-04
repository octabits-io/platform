/**
 * `call(...)` — the one adapter between `hc`'s Response-based API and the
 * `{ data, error }` envelope this app's call sites were written against.
 *
 * Eden Treaty resolved to `{ data, error }` with the union already split:
 * `if (error) { … ; return }` and `data` was the success shape. `hc` resolves
 * to a typed `Response` instead, so the same call site would need
 * `const res = await …; if (!res.ok) { toastError(await res.json()); return };
 * const data = await res.json()` — three lines and an easy-to-forget `await`
 * on every one of the 23 sites. This wrapper puts the split back:
 *
 * ```ts
 * const { data, error } = await call(api.contacts.$get({ query }))
 * if (error) { toastError(error); return }
 * rows.value = data.items          // narrowed, no cast
 * ```
 *
 * Two things make it typed rather than `any`-shaped:
 *
 * - `hc` types a route's response as a **union** of `ClientResponse`s, one per
 *   declared status, and each carries a literal `ok: true | false`. Filtering
 *   the union on that literal is what splits success from error bodies —
 *   `SuccessBody`/`FailureBody` below are that filter.
 * - The return type is a discriminated union on `error: null`, so destructuring
 *   plus `if (error)` narrows `data` to non-null with no `!` and no cast.
 *
 * The error envelope is `{ status, value }` — Eden's shape, kept deliberately:
 * the kit's `createApiErrorMessenger` already unwraps `{ value }`, so
 * `toastError(error)` needed no change anywhere.
 *
 * Framework note: this is 20 lines of app code, not a missing framework
 * feature. But every `hc` consumer writes some version of it, so it is the
 * shape reynt should copy rather than reinvent per page.
 */
import type { ClientResponse } from 'hono/client'

/** Any typed `hc` response — the union member shape we filter on. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClientResponse = ClientResponse<any, any, any>

/**
 * The bodies of the non-2xx members. `ClientResponse` types `ok` as the literal
 * `false` exactly when its status union is entirely non-2xx — which is what
 * `errorJson` produces server-side (it asserts a 4xx/5xx status), so every
 * error branch lands here.
 */
type FailureBody<R> = R extends { ok: false, json: () => Promise<infer T> } ? T : never

/**
 * The bodies of everything else — i.e. success.
 *
 * Deliberately "not provably an error" rather than `{ ok: true }`: a handler
 * that returns `c.json(value)` with no explicit status gets the wide
 * `ContentfulStatusCode`, so `ok` widens to `boolean` and an `{ ok: true }`
 * filter silently yields `never` for most routes. (`c.json(value, 201)` does
 * narrow to `true` — the mix is why the filter has to be by exclusion.)
 */
type SuccessBody<R> = R extends { ok: false }
  ? never
  : R extends { json: () => Promise<infer T> } ? T : never

/** Eden-shaped error envelope: HTTP status plus the parsed body. */
export interface ApiFailure<E> {
  status: number
  value: E
}

export type ApiResult<R> =
  | { data: SuccessBody<R>, error: null, status: number }
  | { data: null, error: ApiFailure<FailureBody<R>>, status: number }

export async function call<R extends AnyClientResponse>(
  request: Promise<R>,
): Promise<ApiResult<R>> {
  const res = await request
  // 204s (and any error page that isn't JSON) have no parseable body — `null`
  // is the honest answer, and no route here reads a 204's body.
  const body = await res.json().catch(() => null)

  return res.ok
    ? { data: body as SuccessBody<R>, error: null, status: res.status }
    : { data: null, error: { status: res.status, value: body as FailureBody<R> }, status: res.status }
}
