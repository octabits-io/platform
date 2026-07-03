import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // Fast, mocked pg-boss — no external services.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/integration.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real Postgres + pg-boss via testcontainers (Docker required).
        test: {
          name: 'integration',
          include: ['src/integration.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
