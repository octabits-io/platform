import { createGlobalSetup } from '../src/testing/index.ts';
import { resolve } from 'node:path';

const { setup, teardown } = createGlobalSetup({
  migrationsFolder: resolve(import.meta.dirname, 'migrations'),
});

export { setup, teardown };
