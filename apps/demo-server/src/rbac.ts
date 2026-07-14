/**
 * RBAC — `…/rbac` is a dependency-free resource/action subset check. The
 * statement matrix and the roles live here, in the consumer, by design: the
 * module ships no roles of its own.
 *
 * How the caller's role is established is out of scope for the module. A real
 * app maps it from a validated JWT claim (`…/auth`'s `createJwtValidationService`
 * takes a caller-supplied claim mapper for exactly this). The demo reads an
 * `x-demo-role` header so the 403 path is one curl away.
 */
import { createRole, checkLocalPermission } from '@octabits-io/framework/rbac';

export const DEMO_STATEMENT = {
  contact: ['read', 'create', 'update', 'delete'],
  note: ['read', 'create', 'update', 'delete'],
  settings: ['read', 'write'],
} as const;

export type DemoStatement = typeof DEMO_STATEMENT;

const roles = {
  admin: createRole<DemoStatement>({
    contact: ['read', 'create', 'update', 'delete'],
    note: ['read', 'create', 'update', 'delete'],
    settings: ['read', 'write'],
  }),
  viewer: createRole<DemoStatement>({
    contact: ['read'],
    note: ['read'],
    settings: ['read'],
  }),
};

export const DEMO_ROLES = Object.keys(roles);

/** `true` iff `roleName` exists and grants every requested resource/action. */
export function hasPermission(
  roleName: string | undefined,
  permissions: Record<string, readonly string[]>,
): boolean {
  if (!roleName) return false;
  return checkLocalPermission(roles, roleName, permissions);
}
