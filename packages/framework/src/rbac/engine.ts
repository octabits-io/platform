/**
 * Self-contained, dependency-free RBAC engine.
 *
 * Pure resource/action subset checking, generic over a caller-supplied
 * permission `statement`. The concrete statement matrix, named roles, and
 * derived permission-request types live in the consuming application — this
 * module only provides the generic primitives.
 */

/**
 * A permission statement: each resource maps to its allowed actions.
 *
 * Callers typically define this as a `const` object (e.g. via `as const`) and
 * derive their domain permission-request type from `typeof statement`.
 */
export type Statement = Record<string, readonly string[]>;

/**
 * Role permissions for a given statement — a subset of the statement's
 * resources, each granting a subset of that resource's actions.
 */
export type RolePermissions<S extends Statement> = {
  [K in keyof S]?: readonly S[K][number][];
};

/** The result of an authorization check. */
export interface AuthorizeResult {
  success: boolean;
}

/** A role: its granted permissions plus an `authorize` subset check. */
export interface Role {
  permissions: Record<string, readonly string[]>;
  /**
   * Returns `{ success: true }` iff every requested resource is granted and
   * every requested action for that resource is included in the grant.
   */
  authorize(requested: Record<string, readonly string[]>): AuthorizeResult;
}

/**
 * Creates a role with an `authorize` method that checks requested permissions
 * against the role's granted permissions (pure subset logic).
 */
export function createRole<S extends Statement>(permissions: RolePermissions<S>): Role {
  return {
    permissions: permissions as Record<string, readonly string[]>,
    authorize(requested: Record<string, readonly string[]>): AuthorizeResult {
      for (const [resource, actions] of Object.entries(requested)) {
        const allowed = (permissions as Record<string, readonly string[] | undefined>)[resource];
        if (!allowed) return { success: false };
        for (const action of actions) {
          if (!allowed.includes(action)) return { success: false };
        }
      }
      return { success: true };
    },
  };
}

/**
 * Check permissions locally against a caller-supplied role registry.
 * Returns `true` iff the named role exists and grants all requested permissions.
 */
export function checkLocalPermission(
  roles: Record<string, Pick<Role, 'authorize'>>,
  roleName: string,
  permissions: Record<string, readonly string[]>,
): boolean {
  const role = roles[roleName];
  if (!role) return false;
  return role.authorize(permissions).success;
}
