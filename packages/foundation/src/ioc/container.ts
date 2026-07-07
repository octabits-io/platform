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

/** Options passed to disposables. `commit` controls whether request-scoped
 *  transactions COMMIT (true) or ROLLBACK (false) when the scope is torn down. */
export interface DisposeOptions {
  commit: boolean;
}

/** A service resolver that holds resources and must be disposed after use. */
export interface DisposableServiceResolver<T> extends ServiceResolver<T> {
  dispose(opts?: DisposeOptions): Promise<void>;
}

/**
 * Factory that creates a disposable system scope for background jobs.
 * `scopeKey` is an optional partition identifier (e.g. a tenant id) for
 * consumers whose system scopes are partition-bound; global background work
 * omits it.
 */
export type SystemScopeFactory<T> = (scopeKey?: string) => Promise<DisposableServiceResolver<T>>;

/**
 * Simple Inversion of Control container with support for singleton, scoped, and transient services.
 */
export class IoC<T> implements ServiceResolver<T> {
  private registrations = new Map<keyof T, ServiceRegistration<any>>()
  private singletons = new Map<keyof T, any>()
  private scoped = new Map<keyof T, any>()
  private parent: IoC<any> | null = null
  private rootCache: IoC<any> | null = null
  private disposables: Array<(opts: DisposeOptions) => void | Promise<void>> = []

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
    // The container whose registration wins — own registrations take
    // precedence over anything cached higher up the chain.
    let owner: IoC<any> = this

    // Walk up the parent chain to find registration
    if (!registration) {
      let currentParent: IoC<any> | null = this.parent
      while (currentParent && !registration) {
        registration = currentParent.registrations.get(key)
        if (registration) {
          owner = currentParent
        }
        currentParent = currentParent.parent
      }
    }

    if (!registration) {
      throw new Error(`Service ${String(key)} not registered.`)
    }

    const { factory, lifetime } = registration

    switch (lifetime) {
      case ServiceLifetime.Singleton: {
        // Singletons are cached on the container that OWNS the registration:
        // root-registered services are shared across all scopes (owner = root),
        // while a scope-level re-registration overrides — it must not be
        // shadowed by an instance the root cached under the same key.
        if (owner.singletons.has(key)) {
          return owner.singletons.get(key) as T[K]
        }

        // Create and cache at the owning container
        // Pass the current container (scope) to the factory for context
        const service = factory(this)
        owner.singletons.set(key, service)
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
   * Find the lifetime of the registration that would resolve for a key
   * (own registration first, then up the parent chain).
   */
  private lifetimeOf(key: keyof T): ServiceLifetime | undefined {
    let container: IoC<any> | null = this
    while (container) {
      const registration = container.registrations.get(key)
      if (registration) {
        return registration.lifetime
      }
      container = container.parent
    }
    return undefined
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
  onDispose(fn: (opts: DisposeOptions) => void | Promise<void>): void {
    this.disposables.push(fn)
  }

  /**
   * Dispose this scope by running all registered cleanup functions in reverse order,
   * then clearing scoped service instances. Does NOT dispose parent or singleton services.
   *
   * `opts` is passed to each disposable. The default (`commit: true`) is intentional:
   * most callers run to completion before disposing, and want their work persisted.
   * Pass `{ commit: false }` from error paths to roll request transactions back.
   */
  async dispose(opts: DisposeOptions = { commit: true }): Promise<void> {
    const errors: unknown[] = []
    for (const fn of this.disposables.reverse()) {
      try {
        await fn(opts)
      } catch (e) {
        // Collect and continue — we must still run remaining disposables
        // (e.g., release a pool client even if RESET threw).
        errors.push(e)
      }
    }
    this.disposables = []
    this.scoped.clear()
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'IoC dispose errors')
  }

  /**
   * Convert the container to a proxy object that resolves services on access
   */
  toServices(): T {
    const target = {} as Record<string, any>
    return new Proxy(target, {
      get: (target, prop) => {
        if (typeof prop === 'string' && this.has(prop as keyof T)) {
          if (prop in target) {
            return target[prop]
          }
          const value = this.resolve(prop as keyof T)
          // Cache resolved services to avoid repeated resolution — but only for
          // singleton/scoped lifetimes. Caching transients here would make them
          // de-facto singletons for this proxy.
          if (this.lifetimeOf(prop as keyof T) !== ServiceLifetime.Transient) {
            target[prop] = value
          }
          return value
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
          // Use cached value if available; cache only non-transient lifetimes
          let value: unknown
          if (prop in target) {
            value = target[prop]
          } else {
            value = this.resolve(prop as keyof T)
            if (this.lifetimeOf(prop as keyof T) !== ServiceLifetime.Transient) {
              target[prop] = value
            }
          }
          return {
            enumerable: true,
            configurable: true,
            value
          }
        }
        return undefined
      }
    }) as T
  }
}
