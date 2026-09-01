import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The kit ships its components as `.vue` SOURCE, so a test that mounts one
  // has to compile it — this plugin is what makes `src/components/*.test.ts`
  // possible at all. It is dev-only: nothing in the published package is built
  // by vitest.
  plugins: [vue()],
  test: {
    include: ['src/**/*.test.ts'],
    // Per-file `@vitest-environment happy-dom` docblocks opt the DOM-needing
    // suites in; everything else stays on the faster node environment.
    environment: 'node',
  },
});
