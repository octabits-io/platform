import { createGlobalSetup } from '../src/index.ts';
import { resolve } from 'node:path';

const { setup, teardown } = createGlobalSetup({
  migrationsFolder: resolve(import.meta.dirname, 'migrations'),
});

export { setup, teardown };
