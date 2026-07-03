import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Fast, no external services.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/testing/setup.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real Postgres via testcontainers (Docker required).
        test: {
          name: 'integration',
          include: ['src/testing/setup.test.ts'],
          environment: 'node',
          globalSetup: './test/global-setup.ts',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
