/**
 * Simple Inversion of Control (IoC) Container
 *
 * This module provides a lightweight dependency injection container with support for
 * singleton, scoped, and transient service lifetimes.
 *
 * **Type Assertion Notes:**
 * This module uses `as any` casts for parent-child container relationships:
 * - `scope.parent = this as any`: Different generic type parameters (IoC<T> vs IoC<T2 & T>)
 * - `this.parent?.has(key as any)`: Key types differ between parent and child
 * - `this.parent.keys() as any[]`: Merging keys from differently-typed containers
 *
 * These assertions are safe because:
 * 1. Child containers extend parent types (T2 & T includes all of T)
 * 2. Service resolution walks up the parent chain correctly
 * 3. Type safety is enforced at registration/resolution call sites
 * 4. This is a common pattern in generic IoC containers across all languages
 */

/**
 * Service lifetime types for dependency injection
 */
export enum ServiceLifetime {
  /** Single instance shared across the entire application */
  Singleton = 'singleton',
  /** New instance per scope (e.g., per request) */
  Scoped = 'scoped',
  /** New instance on every resolution */
  Transient = 'transient',
}

interface ServiceRegistration<T> {
  factory: (container: IoC<any>) => T;
  lifetime: ServiceLifetime;
}

/**
 * Read-only service resolution contract.
 * Use this when code needs to resolve services but should not register or manage the container.
 * Accepts a narrow interface to limit which services are visible at the type level.
 */
export interface ServiceResolver<T> {
  resolve<K extends keyof T>(key: K): T[K];
}

/** A service resolver that holds resources and must be disposed after use. */
export interface DisposableServiceResolver<T> extends ServiceResolver<T> {
  dispose(): Promise<void>;
}

/** Factory that creates a disposable, tenant-scoped system scope for background jobs. */
export type SystemScopeFactory<T> = (tenantId: string) => Promise<DisposableServiceResolver<T>>;

/**
 * Simple Inversion of Control container with support for singleton, scoped, and transient services.
 */
export class IoC<T> implements ServiceResolver<T> {
  private registrations = new Map<keyof T, ServiceRegistration<any>>()
  private singletons = new Map<keyof T, any>()
  private scoped = new Map<keyof T, any>()
  private parent: IoC<any> | null = null
  private rootCache: IoC<any> | null = null
  private disposables: Array<() => void | Promise<void>> = []

  /**
   * Register a service with a factory function and lifetime
   * @param key - The service key
   * @param factory - Factory function to create the service (receives the container as context)
   * @param lifetime - Service lifetime (singleton, scoped, or transient)
   */
  register<K extends keyof T>(
    key: K,
    factory: (container: IoC<T>) => T[K],
    lifetime: ServiceLifetime = ServiceLifetime.Singleton
  ): void {
    this.registrations.set(key, { factory, lifetime })

    // Clear cached instances if re-registering
    if (this.singletons.has(key)) {
      this.singletons.delete(key)
    }
    if (this.scoped.has(key)) {
      this.scoped.delete(key)
    }
  }

  /**
   * Resolve and get the service instance according to its lifetime
   * @param key - The service key to resolve
   */
  resolve<K extends keyof T>(key: K): T[K] {
    let registration = this.registrations.get(key)

    // Walk up the parent chain to find registration
    if (!registration) {
      let currentParent: IoC<any> | null = this.parent
      while (currentParent && !registration) {
        registration = currentParent.registrations.get(key)
        currentParent = currentParent.parent
      }
    }

    if (!registration) {
      throw new Error(`Service ${String(key)} not registered.`)
    }

    const { factory, lifetime } = registration

    switch (lifetime) {
      case ServiceLifetime.Singleton: {
        // For singletons, always use the root container's cache
        const root = this.getRoot()

        // Check singleton cache
        if (root.singletons.has(key)) {
          return root.singletons.get(key) as T[K]
        }

        // Create and cache at root level
        // Pass the current container (scope) to the factory for context
        const service = factory(this)
        root.singletons.set(key, service)
        return service
      }

      case ServiceLifetime.Scoped: {
        // Scoped services are cached per scope (this container)
        if (this.scoped.has(key)) {
          return this.scoped.get(key) as T[K]
        }

        // Create a new instance in this scope
        // Pass the current container (scope) to the factory so it can resolve scoped dependencies
        // This ensures that scoped services use the correct dependencies from the current scope
        const service = factory(this)
        this.scoped.set(key, service)
        return service
      }

      case ServiceLifetime.Transient: {
        // Transient services are never cached
        // Pass the current container (scope) to the factory
        return factory(this)
      }

      default: {
        throw new Error(`Unknown service lifetime: ${lifetime}`)
      }
    }
  }

  /**
   * Get the root container (top-most parent)
   */
  private getRoot(): IoC<any> {
    if (this.rootCache) {
      return this.rootCache
    }

    let root: IoC<any> = this
    while (root.parent) {
      root = root.parent
    }

    // Cache the root reference
    this.rootCache = root
    return root
  }

  /**
   * Create a new scoped container that inherits from this container.
   * Scoped services will be isolated to the new scope, while singletons are shared.
   * @returns A new IoC container that can resolve services from parent
   */
  createScope<T2 = {}>(): IoC<T2 & T> {
    const scope = new IoC<T2 & T>()
    scope.parent = this as any
    // Pre-cache the root to avoid traversal
    scope.rootCache = this.getRoot()
    return scope
  }

  /**
   * Check if a service is registered in this container or its parent
   */
  has(key: keyof T): boolean {
    return this.registrations.has(key) || (this.parent?.has(key as any) ?? false)
  }

  /**
   * Get all registered service keys
   */
  keys(): (keyof T)[] {
    const ownKeys = Array.from(this.registrations.keys())
    const parentKeys = this.parent ? (this.parent.keys() as any[]) : []
    return [...new Set([...ownKeys, ...parentKeys])]
  }

  /**
   * Register a cleanup function to be called when this scope is disposed.
   * Disposables run in reverse order (LIFO) during dispose().
   */
  onDispose(fn: () => void | Promise<void>): void {
    this.disposables.push(fn)
  }

  /**
   * Dispose this scope by running all registered cleanup functions in reverse order,
   * then clearing scoped service instances. Does NOT dispose parent or singleton services.
   */
  async dispose(): Promise<void> {
    for (const fn of this.disposables.reverse()) {
      await fn()
    }
    this.disposables = []
    this.scoped.clear()
  }

  /**
   * Convert the container to a proxy object that resolves services on access
   */
  toServices(): T {
    const target = {} as Record<string, any>
    return new Proxy(target, {
      get: (target, prop) => {
        if (typeof prop === 'string' && this.has(prop as keyof T)) {
          // Cache resolved services in the target to avoid repeated resolution
          if (!(prop in target)) {
            target[prop] = this.resolve(prop as keyof T)
          }
          return target[prop]
        }
        return undefined
      },
      has: (target, prop) => {
        return typeof prop === 'string' && this.has(prop as keyof T)
      },
      ownKeys: (target) => {
        return this.keys() as string[]
      },
      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop === 'string' && this.has(prop as keyof T)) {
          // Use cached value if available
          if (!(prop in target)) {
            target[prop] = this.resolve(prop as keyof T)
          }
          return {
            enumerable: true,
            configurable: true,
            value: target[prop]
          }
        }
        return undefined
      }
    }) as T
  }
}
