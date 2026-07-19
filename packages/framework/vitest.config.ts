import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { reporter: ['text'] },
    projects: [
      {
        // Fast, no external services (vendor clients are mocked in unit tests).
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.ts'],
          exclude: ['src/**/integration.test.ts'],
          environment: 'node',
        },
      },
      {
        // Real backing services via testcontainers (Docker required). Every
        // module drops its `<module>/integration.test.ts` here: queue → pg-boss
        // on Postgres, storage → MinIO, vault → Vault, mail → Mailpit, zitadel →
        // Zitadel. Kept serial — each file boots its own container(s).
        test: {
          name: 'integration',
          include: ['src/**/integration.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
