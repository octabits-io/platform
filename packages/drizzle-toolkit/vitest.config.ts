import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: './test/global-setup.ts',
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
