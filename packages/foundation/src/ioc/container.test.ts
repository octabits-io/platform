import { describe, expect, it } from 'vitest'
import { IoC, ServiceLifetime } from './container.ts'

describe('IoC Container', () => {
  describe('Singleton Services', () => {
    it('should return the same instance on multiple resolves', () => {
      const container = new IoC<{ counter: { count: number; increment: () => void } }>()

      let counter = 0
      container.register(
        'counter',
        () => ({
          count: 0,
          increment() {
            this.count++
            counter++
          }
        }),
        ServiceLifetime.Singleton
      )

      const service1 = container.resolve('counter')
      const service2 = container.resolve('counter')

      expect(service1).toBe(service2)

      service1.increment()
      expect(service1.count).toBe(1)
      expect(service2.count).toBe(1)
      expect(counter).toBe(1)
    })

    it('should default to singleton lifetime when not specified', () => {
      const container = new IoC<{ value: number }>()

      let callCount = 0
      container.register('value', () => {
        callCount++
        return 42
      })

      container.resolve('value')
      container.resolve('value')
      container.resolve('value')

      expect(callCount).toBe(1)
    })

    it('should share singletons across scopes', () => {
      const container = new IoC<{ config: { apiKey: string } }>()

      container.register(
        'config',
        () => ({ apiKey: 'secret-key' }),
        ServiceLifetime.Singleton
      )

      const scope1 = container.createScope()
      const scope2 = container.createScope()

      const config1 = scope1.resolve('config')
      const config2 = scope2.resolve('config')

      expect(config1).toBe(config2)
    })
  })

  describe('Scoped Services', () => {
    it('should return the same instance within a scope', () => {
      const container = new IoC<{ requestId: string }>()

      container.register(
        'requestId',
        () => Math.random().toString(36),
        ServiceLifetime.Scoped
      )

      const scope = container.createScope()
      const id1 = scope.resolve('requestId')
      const id2 = scope.resolve('requestId')

      expect(id1).toBe(id2)
    })

    it('should return different instances across different scopes', () => {
      const container = new IoC<{ sessionId: string }>()

      container.register(
        'sessionId',
        () => Math.random().toString(36),
        ServiceLifetime.Scoped
      )

      const scope1 = container.createScope()
      const scope2 = container.createScope()

      const session1 = scope1.resolve('sessionId')
      const session2 = scope2.resolve('sessionId')

      expect(session1).not.toBe(session2)
    })

    it('should isolate scoped service instances per request', () => {
      interface Services {
        userId: string
        logger: { log: (msg: string) => void; userId: string }
      }

      const container = new IoC<Services>()

      // User ID is scoped to each request
      container.register(
        'userId',
        () => `user-${Math.random().toString(36).slice(2, 9)}`,
        ServiceLifetime.Scoped
      )

      // Logger depends on userId
      container.register(
        'logger',
        () => {
          const scope = container.createScope()
          const userId = scope.resolve('userId')
          return {
            userId,
            log: (msg: string) => console.log(`[${userId}] ${msg}`)
          }
        },
        ServiceLifetime.Scoped
      )

      const request1 = container.createScope()
      const request2 = container.createScope()

      const user1 = request1.resolve('userId')
      const user2 = request2.resolve('userId')

      expect(user1).not.toBe(user2)
    })
  })

  describe('Transient Services', () => {
    it('should return a new instance on every resolve', () => {
      const container = new IoC<{ timestamp: number }>()

      container.register(
        'timestamp',
        () => Date.now(),
        ServiceLifetime.Transient
      )

      const time1 = container.resolve('timestamp')
      const time2 = container.resolve('timestamp')

      // These should be different (or potentially the same if resolved too quickly)
      // The key is that the factory is called each time
      expect(typeof time1).toBe('number')
      expect(typeof time2).toBe('number')
    })

    it('should call the factory function on every resolve', () => {
      const container = new IoC<{ value: number }>()

      let callCount = 0
      container.register(
        'value',
        () => {
          callCount++
          return 42
        },
        ServiceLifetime.Transient
      )

      container.resolve('value')
      container.resolve('value')
      container.resolve('value')

      expect(callCount).toBe(3)
    })

    it('should create new instances even within the same scope', () => {
      const container = new IoC<{ uuid: string }>()

      container.register(
        'uuid',
        () => Math.random().toString(36),
        ServiceLifetime.Transient
      )

      const scope = container.createScope()

      const uuid1 = scope.resolve('uuid')
      const uuid2 = scope.resolve('uuid')

      expect(uuid1).not.toBe(uuid2)
    })
  })

  describe('Scope Creation', () => {
    it('should allow createScope to be called without type parameter', () => {
      const container = new IoC<{ parent: string }>()
      container.register('parent', () => 'parent-value')

      const scope = container.createScope()
      const value = scope.resolve('parent')

      expect(value).toBe('parent-value')
    })

    it('should allow adding new services to a scope', () => {
      interface ParentServices {
        config: { appName: string }
      }

      const container = new IoC<ParentServices>()
      container.register('config', () => ({ appName: 'MyApp' }), ServiceLifetime.Singleton)

      const scope = container.createScope<{ requestId: string }>()
      scope.register('requestId', () => 'req-123', ServiceLifetime.Scoped)

      const config = scope.resolve('config')
      const requestId = scope.resolve('requestId')

      expect(config.appName).toBe('MyApp')
      expect(requestId).toBe('req-123')
    })
  })

  describe('Service Resolution', () => {
    it('should throw error when resolving unregistered service', () => {
      const container = new IoC<{ missing: string }>()

      expect(() => container.resolve('missing')).toThrow(
        'Service missing not registered.'
      )
    })

    it('should resolve services from parent container', () => {
      const container = new IoC<{ parent: string }>()
      container.register('parent', () => 'from-parent')

      const scope = container.createScope<{ child: string }>()
      scope.register('child', () => 'from-child')

      expect(scope.resolve('parent')).toBe('from-parent')
      expect(scope.resolve('child')).toBe('from-child')
    })

    it('should check if service exists using has()', () => {
      const container = new IoC<{ exists: string; missing: string }>()
      container.register('exists', () => 'yes')

      expect(container.has('exists')).toBe(true)
      expect(container.has('missing')).toBe(false)
    })

    it('should check parent container in has()', () => {
      const container = new IoC<{ parent: string }>()
      container.register('parent', () => 'value')

      const scope = container.createScope<{ child: string }>()
      scope.register('child', () => 'value')

      expect(scope.has('parent')).toBe(true)
      expect(scope.has('child')).toBe(true)
    })

    it('should return all keys including parent keys', () => {
      const container = new IoC<{ a: string; b: string }>()
      container.register('a', () => 'a')
      container.register('b', () => 'b')

      const scope = container.createScope<{ c: string }>()
      scope.register('c', () => 'c')

      const keys = scope.keys()
      expect(keys).toContain('a')
      expect(keys).toContain('b')
      expect(keys).toContain('c')
    })
  })

  describe('toServices Proxy', () => {
    it('should resolve services through proxy getter', () => {
      const container = new IoC<{ message: string }>()
      container.register('message', () => 'Hello, World!')

      const services = container.toServices()
      expect(services.message).toBe('Hello, World!')
    })

    it('should support "in" operator', () => {
      const container = new IoC<{ exists: string; missing: string }>()
      container.register('exists', () => 'yes')

      const services = container.toServices()
      expect('exists' in services).toBe(true)
      expect('missing' in services).toBe(false)
    })

    it('should enumerate service keys', () => {
      const container = new IoC<{ a: number; b: number; c: number }>()
      container.register('a', () => 1)
      container.register('b', () => 2)
      container.register('c', () => 3)

      const services = container.toServices()
      const keys = Object.keys(services)

      expect(keys).toContain('a')
      expect(keys).toContain('b')
      expect(keys).toContain('c')
    })

    it('should return undefined for unregistered services', () => {
      const container = new IoC<{ exists: string; missing: string }>()
      container.register('exists', () => 'yes')

      const services = container.toServices()
      expect(services.exists).toBe('yes')
      expect(services.missing).toBeUndefined()
    })
  })

  describe('Re-registration', () => {
    it('should clear cached singleton when re-registering', () => {
      const container = new IoC<{ value: number }>()

      container.register('value', () => 1, ServiceLifetime.Singleton)
      const first = container.resolve('value')

      container.register('value', () => 2, ServiceLifetime.Singleton)
      const second = container.resolve('value')

      expect(first).toBe(1)
      expect(second).toBe(2)
    })

    it('should clear cached scoped service when re-registering', () => {
      const container = new IoC<{ value: number }>()

      container.register('value', () => 1, ServiceLifetime.Scoped)
      const scope = container.createScope()
      const first = scope.resolve('value')

      // Re-register in parent
      container.register('value', () => 2, ServiceLifetime.Scoped)

      // Create a NEW scope to see the updated registration
      const newScope = container.createScope()
      const second = newScope.resolve('value')

      expect(first).toBe(1)
      expect(second).toBe(2)
    })
  })

  describe('Real-world Example: HTTP Request Handling', () => {
    interface AppServices {
      config: { dbUrl: string; apiKey: string }
      database: { query: (sql: string) => Promise<any> }
    }

    interface RequestServices extends AppServices {
      requestId: string
      userId: string | null
      logger: { info: (msg: string) => void; error: (msg: string) => void }
      userRepository: { findById: (id: string) => Promise<any> }
    }

    it('should handle request-scoped services in a typical web app', () => {
      // Application-level container with singleton services
      const app = new IoC<AppServices>()

      app.register(
        'config',
        () => ({
          dbUrl: 'postgresql://localhost/mydb',
          apiKey: 'app-secret-key'
        }),
        ServiceLifetime.Singleton
      )

      app.register(
        'database',
        () => ({
          query: async (sql: string) => ({ sql })
        }),
        ServiceLifetime.Singleton
      )

      // Simulate handling a request
      const handleRequest = (userId: string | null) => {
        const request = app.createScope<Omit<RequestServices, keyof AppServices>>()

        request.register(
          'requestId',
          () => `req-${Math.random().toString(36).slice(2, 9)}`,
          ServiceLifetime.Scoped
        )

        request.register(
          'userId',
          () => userId,
          ServiceLifetime.Scoped
        )

        request.register(
          'logger',
          () => {
            const reqId = request.resolve('requestId')
            const uid = request.resolve('userId')
            return {
              info: (msg: string) => console.log(`[${reqId}][${uid}] INFO: ${msg}`),
              error: (msg: string) => console.error(`[${reqId}][${uid}] ERROR: ${msg}`)
            }
          },
          ServiceLifetime.Scoped
        )

        request.register(
          'userRepository',
          () => {
            const db = request.resolve('database')
            return {
              findById: async (id: string) => {
                return db.query(`SELECT * FROM users WHERE id = '${id}'`)
              }
            }
          },
          ServiceLifetime.Transient
        )

        return request
      }

      const req1 = handleRequest('user-123')
      const req2 = handleRequest('user-456')

      const reqId1 = req1.resolve('requestId')
      const reqId2 = req2.resolve('requestId')
      expect(reqId1).not.toBe(reqId2)

      expect(req1.resolve('userId')).toBe('user-123')
      expect(req2.resolve('userId')).toBe('user-456')

      const config1 = req1.resolve('config')
      const config2 = req2.resolve('config')
      expect(config1).toBe(config2)

      const db1 = req1.resolve('database')
      const db2 = req2.resolve('database')
      expect(db1).toBe(db2)

      const logger1 = req1.resolve('logger')
      const logger2 = req2.resolve('logger')
      expect(logger1).not.toBe(logger2)

      const repo1a = req1.resolve('userRepository')
      const repo1b = req1.resolve('userRepository')
      expect(repo1a).not.toBe(repo1b)
    })
  })

  describe('Child Scope Inheritance', () => {
    it('should inherit scoped services from parent scope when creating child scope', () => {
      interface Services {
        headers: Record<string, string>
        tenantResolver: { getTenantId: () => string }
        objectStorageService: { bucket: string; upload: () => void }
      }

      const container = new IoC<Services>()

      container.register(
        'tenantResolver',
        (scope) => {
          const headers = scope.resolve('headers')
          return {
            getTenantId: () => headers['x-tenant-id'] || 'default'
          }
        },
        ServiceLifetime.Scoped
      )

      container.register(
        'objectStorageService',
        (scope) => {
          const tenantResolver = scope.resolve('tenantResolver')
          const tenantId = tenantResolver.getTenantId()
          return {
            bucket: tenantId,
            upload: () => console.log(`Uploading to ${tenantId}`)
          }
        },
        ServiceLifetime.Scoped
      )

      const requestScope = container.createScope()
      requestScope.register(
        'headers',
        () => ({ 'x-tenant-id': 'tenant-abc' }),
        ServiceLifetime.Scoped
      )

      const storage1 = requestScope.resolve('objectStorageService')
      expect(storage1.bucket).toBe('tenant-abc')

      const childScope = requestScope.createScope()
      childScope.register(
        'tenantResolver',
        () => ({
          getTenantId: () => 'tenant-xyz'
        }),
        ServiceLifetime.Scoped
      )

      const headersInChild = childScope.resolve('headers')
      expect(headersInChild).toEqual({ 'x-tenant-id': 'tenant-abc' })

      const storage2 = childScope.resolve('objectStorageService')
      expect(storage2.bucket).toBe('tenant-xyz')
      expect(storage2).not.toBe(storage1)
    })

    it('should reuse parent scoped services when not overridden in child scope', () => {
      interface Services {
        headers: Record<string, string>
        logger: { requestId: string; log: (msg: string) => void }
        tenantResolver: { getTenantId: () => string }
      }

      const container = new IoC<Services>()

      container.register(
        'logger',
        (scope) => {
          const headers = scope.resolve('headers')
          return {
            requestId: headers['x-request-id'] || 'unknown',
            log: (msg: string) => console.log(`[${headers['x-request-id']}] ${msg}`)
          }
        },
        ServiceLifetime.Scoped
      )

      container.register(
        'tenantResolver',
        () => ({
          getTenantId: () => 'default-tenant'
        }),
        ServiceLifetime.Scoped
      )

      const parentScope = container.createScope()
      parentScope.register(
        'headers',
        () => ({ 'x-request-id': 'req-123' }),
        ServiceLifetime.Scoped
      )

      const parentLogger = parentScope.resolve('logger')
      expect(parentLogger.requestId).toBe('req-123')

      const childScope = parentScope.createScope()

      const childLogger = childScope.resolve('logger')
      expect(childLogger).not.toBe(parentLogger)
      expect(childLogger.requestId).toBe('req-123')

      childScope.register(
        'tenantResolver',
        () => ({
          getTenantId: () => 'child-tenant'
        }),
        ServiceLifetime.Scoped
      )

      const childResolver = childScope.resolve('tenantResolver')
      expect(childResolver.getTenantId()).toBe('child-tenant')

      const parentResolver = parentScope.resolve('tenantResolver')
      expect(parentResolver.getTenantId()).toBe('default-tenant')
    })

    it('should handle deeply nested scopes', () => {
      interface Services {
        level: string
        path: string[]
      }

      const root = new IoC<Services>()

      root.register(
        'level',
        () => 'root',
        ServiceLifetime.Scoped
      )

      root.register(
        'path',
        (scope) => {
          const level = scope.resolve('level')
          return [level]
        },
        ServiceLifetime.Scoped
      )

      const scope1 = root.createScope()
      scope1.register('level', () => 'scope1', ServiceLifetime.Scoped)

      const scope2 = scope1.createScope()
      scope2.register('level', () => 'scope2', ServiceLifetime.Scoped)

      const scope3 = scope2.createScope()
      scope3.register('level', () => 'scope3', ServiceLifetime.Scoped)

      expect(root.resolve('level')).toBe('root')
      expect(scope1.resolve('level')).toBe('scope1')
      expect(scope2.resolve('level')).toBe('scope2')
      expect(scope3.resolve('level')).toBe('scope3')

      expect(scope1.resolve('path')).toEqual(['scope1'])
      expect(scope2.resolve('path')).toEqual(['scope2'])
      expect(scope3.resolve('path')).toEqual(['scope3'])
    })

    it('should throw error if child scope tries to resolve service that needs missing dependency', () => {
      interface Services {
        headers: Record<string, string>
        authzService: { userId: string | null }
      }

      const container = new IoC<Services>()

      container.register(
        'authzService',
        (scope) => {
          const headers = scope.resolve('headers')
          return {
            userId: headers['x-user-id'] || null
          }
        },
        ServiceLifetime.Scoped
      )

      const childScope = container.createScope()

      expect(() => childScope.resolve('authzService')).toThrow(
        'Service headers not registered.'
      )
    })

    it('should allow multiple levels of service overrides in child scopes', () => {
      interface Services {
        config: { value: string }
        derivedValue: string
      }

      const root = new IoC<Services>()

      root.register(
        'config',
        () => ({ value: 'root-config' }),
        ServiceLifetime.Scoped
      )

      root.register(
        'derivedValue',
        (scope) => {
          const config = scope.resolve('config')
          return `derived-from-${config.value}`
        },
        ServiceLifetime.Scoped
      )

      const child1 = root.createScope()
      child1.register(
        'config',
        () => ({ value: 'child1-config' }),
        ServiceLifetime.Scoped
      )

      expect(child1.resolve('derivedValue')).toBe('derived-from-child1-config')

      const child2 = child1.createScope()
      child2.register(
        'config',
        () => ({ value: 'child2-config' }),
        ServiceLifetime.Scoped
      )

      expect(child2.resolve('derivedValue')).toBe('derived-from-child2-config')
      expect(child1.resolve('derivedValue')).toBe('derived-from-child1-config')
      expect(root.resolve('derivedValue')).toBe('derived-from-root-config')
    })
  })

  describe('Dispose Lifecycle', () => {
    it('should run disposables in reverse order', async () => {
      const container = new IoC<{ value: string }>()
      container.register('value', () => 'test', ServiceLifetime.Singleton)

      const scope = container.createScope()
      const order: number[] = []
      scope.onDispose(() => { order.push(1) })
      scope.onDispose(() => { order.push(2) })
      scope.onDispose(() => { order.push(3) })

      await scope.dispose()
      expect(order).toEqual([3, 2, 1])
    })

    it('should handle async disposables', async () => {
      const container = new IoC<{ value: string }>()
      container.register('value', () => 'test', ServiceLifetime.Singleton)

      const scope = container.createScope()
      const order: number[] = []
      scope.onDispose(async () => {
        await new Promise(r => setTimeout(r, 10))
        order.push(1)
      })
      scope.onDispose(async () => {
        await new Promise(r => setTimeout(r, 5))
        order.push(2)
      })

      await scope.dispose()
      expect(order).toEqual([2, 1])
    })

    it('should clear scoped instances on dispose', async () => {
      const container = new IoC<{ counter: number }>()
      let count = 0
      container.register('counter', () => ++count, ServiceLifetime.Scoped)

      const scope = container.createScope()
      const first = scope.resolve('counter')
      expect(first).toBe(1)

      expect(scope.resolve('counter')).toBe(1)

      await scope.dispose()

      const second = scope.resolve('counter')
      expect(second).toBe(2)
    })

    it('should not affect parent container on dispose', async () => {
      const container = new IoC<{ config: string }>()
      container.register('config', () => 'root-config', ServiceLifetime.Singleton)

      const scope = container.createScope()
      scope.onDispose(() => {})

      await scope.dispose()

      expect(container.resolve('config')).toBe('root-config')
    })

    it('should clear disposables after dispose so they do not run twice', async () => {
      const container = new IoC<{ value: string }>()
      container.register('value', () => 'test', ServiceLifetime.Singleton)

      const scope = container.createScope()
      let runCount = 0
      scope.onDispose(() => { runCount++ })

      await scope.dispose()
      expect(runCount).toBe(1)

      await scope.dispose()
      expect(runCount).toBe(1)
    })
  })

  describe('Scoped Services with Request Context', () => {
    it('should register scoped service once on parent and inject request-specific values per scope', () => {
      interface AppServices {
        logger: { log: (msg: string) => void; name: string }
      }

      interface RequestServices extends AppServices {
        headers: Record<string, string>
        authzService: {
          getUserId: () => string | null
          hasPermission: (perm: string) => boolean
        }
      }

      const app = new IoC<RequestServices>()

      app.register(
        'logger',
        () => ({
          name: 'AppLogger',
          log: (msg: string) => console.log(`[APP] ${msg}`)
        }),
        ServiceLifetime.Singleton
      )

      app.register(
        'authzService',
        (container: IoC<RequestServices>) => {
          const headers = container.resolve('headers')
          const userId = headers['x-user-id'] || null

          return {
            getUserId: () => userId,
            hasPermission: (perm: string) => {
              return userId !== null && perm === 'read'
            }
          }
        },
        ServiceLifetime.Scoped
      )

      const request1 = app.createScope()
      request1.register(
        'headers',
        () => ({ 'x-user-id': 'user-123', 'x-tenant-id': 'tenant-a' }),
        ServiceLifetime.Scoped
      )

      const request2 = app.createScope()
      request2.register(
        'headers',
        () => ({ 'x-user-id': 'user-456', 'x-tenant-id': 'tenant-b' }),
        ServiceLifetime.Scoped
      )

      const request3 = app.createScope()
      request3.register(
        'headers',
        () => ({ 'x-tenant-id': 'tenant-c' }),
        ServiceLifetime.Scoped
      )

      const authz1 = request1.resolve('authzService')
      const authz2 = request2.resolve('authzService')
      const authz3 = request3.resolve('authzService')

      expect(authz1).not.toBe(authz2)
      expect(authz2).not.toBe(authz3)

      expect(authz1.getUserId()).toBe('user-123')
      expect(authz2.getUserId()).toBe('user-456')
      expect(authz3.getUserId()).toBeNull()

      expect(authz1.hasPermission('read')).toBe(true)
      expect(authz2.hasPermission('read')).toBe(true)
      expect(authz3.hasPermission('read')).toBe(false)

      const authz1Again = request1.resolve('authzService')
      expect(authz1).toBe(authz1Again)

      const logger1 = request1.resolve('logger')
      const logger2 = request2.resolve('logger')
      const logger3 = request3.resolve('logger')

      expect(logger1).toBe(logger2)
      expect(logger2).toBe(logger3)
      expect(logger1.name).toBe('AppLogger')
    })

    it('should allow authz service to be registered once and resolve headers lazily', () => {
      interface Services {
        headers: { authorization: string }
        authzService: { token: string; isValid: () => boolean }
      }

      const container = new IoC<Services>()

      container.register(
        'authzService',
        (scope: IoC<Services>) => {
          const headers = scope.resolve('headers')
          return {
            token: headers.authorization,
            isValid: () => headers.authorization.startsWith('Bearer ')
          }
        },
        ServiceLifetime.Scoped
      )

      const scope1 = container.createScope()
      scope1.register(
        'headers',
        () => ({ authorization: 'Bearer valid-token-1' }),
        ServiceLifetime.Scoped
      )

      const scope2 = container.createScope()
      scope2.register(
        'headers',
        () => ({ authorization: 'Invalid token-2' }),
        ServiceLifetime.Scoped
      )

      const authz1 = scope1.resolve('authzService')
      const authz2 = scope2.resolve('authzService')

      expect(authz1.token).toBe('Bearer valid-token-1')
      expect(authz1.isValid()).toBe(true)

      expect(authz2.token).toBe('Invalid token-2')
      expect(authz2.isValid()).toBe(false)

      expect(authz1).not.toBe(authz2)
    })
  })
})
