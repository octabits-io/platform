import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { reporter: ['text'] },
    projects: [
      {
        // Fast, no external services (queue's pg-boss is mocked in its unit tests).
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.ts'],
          exclude: ['src/queue/integration.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real Postgres + pg-boss via testcontainers (Docker required).
        test: {
          name: 'integration',
          include: ['src/queue/integration.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
