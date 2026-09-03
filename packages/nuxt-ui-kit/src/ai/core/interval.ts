/**
 * Minimal pausable interval — avoids a @vueuse/core peer for one helper, and
 * carries no reactivity of its own: `isActive()` is a plain read, and a caller
 * that wants to be told about transitions passes `onActiveChange`.
 *
 * Not auto-disposed; callers pause it in their own teardown.
 */
export interface PausableInterval {
  pause(): void;
  resume(): void;
  isActive(): boolean;
}

export function createPausableInterval(
  fn: () => void | Promise<void>,
  ms: number,
  onActiveChange?: (active: boolean) => void,
): PausableInterval {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    onActiveChange?.(next);
  }

  function resume() {
    if (timer) return;
    timer = setInterval(() => void fn(), ms);
    setActive(true);
  }

  function pause() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    setActive(false);
  }

  return { pause, resume, isActive: () => active };
}
