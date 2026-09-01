/**
 * `.vue` module shim for this package's own `tsc --noEmit`.
 *
 * The kit ships its components as source and they are type-checked by
 * consumers' `nuxt typecheck` (vue-tsc cannot run in this repo — TS7). Plain
 * `tsc` therefore cannot resolve a `.vue` import at all, which the component
 * MOUNT TESTS (`src/components/*.test.ts`) need. Props stay loosely typed
 * here on purpose: the real prop contracts are checked where the SFCs are
 * compiled, and the mount tests assert behaviour, not types.
 *
 * Never published — only built entries land in `dist`.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
