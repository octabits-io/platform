/**
 * Typed workflow-type registry — the app owns its definition shape (trigger
 * API context, dynamic components, label keys); the kit owns registration and
 * label lookup.
 */
export interface WorkflowRegistryOptions {
  /**
   * Label-key fallbacks for types that have no registered definition
   * (e.g. usage-only rows like embedding jobs).
   */
  extraLabelKeys?: Record<string, string>;
}

export function createWorkflowRegistry<
  TDefinition extends { type: string; labelKey: string },
>(options: WorkflowRegistryOptions = {}) {
  const registry = new Map<string, TDefinition>();

  function register(definition: TDefinition): void {
    registry.set(definition.type, definition);
  }

  function get(type: string): TDefinition | undefined {
    return registry.get(type);
  }

  function getAll(): TDefinition[] {
    return Array.from(registry.values());
  }

  /** Human label for a type: definition labelKey → extra fallback key → raw type. */
  function getLabel(type: string, t: (key: string) => string): string {
    const def = registry.get(type);
    if (def) return t(def.labelKey);
    const extraKey = options.extraLabelKeys?.[type];
    if (extraKey) return t(extraKey);
    return type;
  }

  return { register, get, getAll, getLabel };
}

export type WorkflowRegistry<TDefinition extends { type: string; labelKey: string }> =
  ReturnType<typeof createWorkflowRegistry<TDefinition>>;
