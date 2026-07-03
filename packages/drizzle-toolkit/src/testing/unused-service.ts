/**
 * Returns a typed placeholder for a dependency that a constructor requires but
 * the test under exercise never actually uses. Any property access on the
 * returned value throws, naming the stub — so a forgotten real dependency
 * fails loudly with a clear message instead of surfacing as an opaque
 * `undefined is not a function` deeper in the call stack.
 *
 * Use sparingly — prefer wiring a real service or a purpose-built mock. This is
 * justified when the alternative is assembling a deep dependency tree solely to
 * satisfy a constructor for a code path the test does not touch.
 *
 * @example
 * ```typescript
 * const service = createOrderService({
 *   db,
 *   tenantId,
 *   // Not exercised by this test — fail loudly if that ever changes.
 *   mailService: unusedService<MailService>('mailService'),
 * });
 * ```
 *
 * @param name - Identifier used in the thrown error to pinpoint the stub.
 */
export function unusedService<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `${name}.${String(prop)} was called but ${name} is an unusedService stub in this test. ` +
            `If the code path under test now depends on ${name}, wire up a real service or a typed mock.`,
        );
      },
    },
  ) as T;
}
