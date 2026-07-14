export {
  IoC,
  ServiceLifetime,
} from './container.ts';
export type {
  ServiceResolver,
  DisposableServiceResolver,
  DisposeOptions,
  SystemScopeFactory,
} from './container.ts';
export { withScope, forEachScope } from './scopes.ts';
export type { ErasedScope, DisposableScope, ForEachScopeResult } from './scopes.ts';
