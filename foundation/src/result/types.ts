import type { OctError } from './error';

export type Result<T = never, E = OctError> =
    | { ok: true; value: T }
    | { ok: false; error: E };