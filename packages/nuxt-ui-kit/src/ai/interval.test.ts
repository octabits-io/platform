/**
 * The pausable interval behind every polling composable in `./ai` (workflow
 * polling, the active-workflow probe). It exists to avoid a `@vueuse/core`
 * peer for one helper, which makes it the kit's own responsibility to prove
 * the two properties every caller relies on: `resume` is idempotent (a second
 * call must not start a second timer that polls twice as fast), and `pause`
 * really clears it (callers pause in teardown — a leaked timer keeps polling a
 * closed page forever).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPausableInterval } from './interval.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPausableInterval', () => {
  it('starts idle — nothing runs until resume', () => {
    const fn = vi.fn();
    const interval = createPausableInterval(fn, 1000);

    expect(interval.isActive.value).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs on the interval once resumed, and reports isActive', () => {
    const fn = vi.fn();
    const interval = createPausableInterval(fn, 1000);

    interval.resume();
    expect(interval.isActive.value).toBe(true);
    // No leading call: the first tick is one interval away.
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('ignores a second resume rather than doubling the cadence', () => {
    const fn = vi.fn();
    const interval = createPausableInterval(fn, 1000);

    interval.resume();
    interval.resume();
    interval.resume();

    vi.advanceTimersByTime(3_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops on pause and can be resumed again', () => {
    const fn = vi.fn();
    const interval = createPausableInterval(fn, 1000);

    interval.resume();
    vi.advanceTimersByTime(2_000);
    interval.pause();
    expect(interval.isActive.value).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);

    interval.resume();
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('tolerates pause before resume, and a repeated pause', () => {
    const fn = vi.fn();
    const interval = createPausableInterval(fn, 1000);

    expect(() => {
      interval.pause();
      interval.pause();
    }).not.toThrow();
    expect(interval.isActive.value).toBe(false);
  });

  it('does not await an async callback — a slow poll cannot stall the timer', async () => {
    let resolve!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const interval = createPausableInterval(fn, 1000);

    interval.resume();
    vi.advanceTimersByTime(3_000);

    expect(fn).toHaveBeenCalledTimes(3);
    resolve();
  });
});
