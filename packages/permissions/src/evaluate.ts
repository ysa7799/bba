import {
  isPermission,
  isSystemRoleKey,
  systemRolePermissions,
  type Permission,
  type SystemRoleKey,
} from './catalogue';

export interface RoleGrant {
  /** System role key, or null for a custom role. */
  systemKey: string | null;
  /** Stored permissions (custom roles only; ignored for system roles). */
  permissions: readonly string[];
}

/**
 * Effective permissions of a set of roles. System roles resolve from code; custom role
 * permissions are filtered against the catalogue so stale/unknown strings never grant access.
 */
export function effectivePermissions(roles: readonly RoleGrant[]): Set<Permission> {
  const result = new Set<Permission>();
  for (const role of roles) {
    const granted =
      role.systemKey !== null && isSystemRoleKey(role.systemKey)
        ? systemRolePermissions(role.systemKey)
        : role.systemKey === null
          ? role.permissions.filter(isPermission)
          : [];
    for (const permission of granted) result.add(permission);
  }
  return result;
}

export function isOwner(roles: readonly RoleGrant[]): boolean {
  return roles.some((role) => role.systemKey === 'owner');
}

/** True when every permission in `requested` is held by `holder` (no privilege escalation). */
export function isSubset(requested: Iterable<string>, holder: ReadonlySet<string>): boolean {
  for (const permission of requested) {
    if (!holder.has(permission)) return false;
  }
  return true;
}

export interface Actor {
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
}

/**
 * An actor may grant (assign or define) a role only if they hold every permission it grants,
 * and only owners may grant the owner role.
 */
export function canGrantRole(actor: Actor, role: RoleGrant): boolean {
  if (role.systemKey === 'owner') return actor.isOwner;
  return isSubset(effectivePermissions([role]), actor.permissions);
}

/**
 * An actor may manage (change roles of, suspend, remove) a member only if the member is not more
 * powerful: owners can only be managed by owners, and the member's permissions must be a subset
 * of the actor's.
 */
export function canManageMember(actor: Actor, target: readonly RoleGrant[]): boolean {
  if (isOwner(target) && !actor.isOwner) return false;
  return isSubset(effectivePermissions(target), actor.permissions);
}

export type { Permission, SystemRoleKey };
