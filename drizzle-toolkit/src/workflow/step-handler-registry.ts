import type { StepHandler, StepHandlerRegistry } from './types.ts';

/**
 * Creates a step handler registry.
 */
export function createStepHandlerRegistry(): StepHandlerRegistry {
  const handlers = new Map<string, StepHandler>();

  return {
    register(type: string, handler: StepHandler): void {
      handlers.set(type, handler);
    },
    get(type: string): StepHandler | undefined {
      return handlers.get(type);
    },
    has(type: string): boolean {
      return handlers.has(type);
    },
    types(): string[] {
      return Array.from(handlers.keys());
    },
  };
}
