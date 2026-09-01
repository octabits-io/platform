import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * A deliberately small suite: this app's job is to be a real consumer, and
 * `nuxt typecheck` plus a browser pass is what proves that. What vitest adds is
 * coverage for the app-owned LOGIC that neither of those can pin — the i18n
 * merge (whose failure mode is a raw key path rendering) and the
 * translation-status rules (whose failure mode is a badge lying about
 * completeness).
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  test: {
    include: ['app/**/*.test.ts'],
    environment: 'node',
  },
})
