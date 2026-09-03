import { ref } from 'vue';

/**
 * Minimal pausable interval — avoids a @vueuse/core peer for one helper.
 * Not auto-disposed; callers pause it in their own teardown.
 */
export function createPausableInterval(fn: () => void | Promise<void>, ms: number) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const isActive = ref(false);

  function resume() {
    if (timer) return;
    isActive.value = true;
    timer = setInterval(() => void fn(), ms);
  }

  function pause() {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    isActive.value = false;
  }

  return { pause, resume, isActive };
}
