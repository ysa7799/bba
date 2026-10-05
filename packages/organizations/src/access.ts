import {
  invitations,
  isUniqueViolation,
  membershipRoles,
  memberships,
  organizations,
  roles,
  type Role,
  type SystemTx,
  type TenantTx,
} from '@businessos/database';
import {
  canGrantRole,
  canManageMember,
  effectivePermissions,
  isPermission,
  SYSTEM_ROLES,
  type Actor,
  type Permission,
  type RoleGrant,
  type SystemRoleKey,
} from '@businessos/permissions';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

/** The acting member, as resolved for a request. */
export interface MemberActor extends Actor {
  userId: string;
  membershipId: string;
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  systemKey: string | null;
  isSystem: boolean;
  /** Effective permissions (system roles resolve from code). */
  permissions: Permission[];
}

function toGrant(role: Pick<Role, 'systemKey' | 'permissions'>): RoleGrant {
  return { systemKey: role.systemKey, permissions: role.permissions };
}

export function toRoleSummary(role: Role): RoleSummary {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    systemKey: role.systemKey,
    isSystem: role.isSystem,
    permissions: [...effectivePermissions([toGrant(role)])],
  };
}

/** Creates the five system roles for a new organization. */
export async function seedSystemRoles(
  tx: SystemTx,
  organizationId: string,
): Promise<Record<SystemRoleKey, string>> {
  const inserted = await tx
    .insert(roles)
    .values(
      SYSTEM_ROLES.map((role) => ({
        organizationId,
        systemKey: role.key,
        name: role.name,
        description: role.description,
        isSystem: true,
      })),
    )
    .returning({ id: roles.id, systemKey: roles.systemKey });
  const map = {} as Record<SystemRoleKey, string>;
  for (const row of inserted) map[row.systemKey as SystemRoleKey] = row.id;
  return map;
}

export interface MembershipAccess {
  roles: RoleSummary[];
  permissions: Set<Permission>;
  isOwner: boolean;
}

async function rolesForMembership(tx: TenantTx | SystemTx, membershipId: string): Promise<Role[]> {
  const rows = await tx
    .select({ role: roles })
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(eq(membershipRoles.membershipId, membershipId))
    .orderBy(asc(roles.name));
  return rows.map((row) => row.role);
}

export async function loadMembershipAccess(
  tx: TenantTx,
  membershipId: string,
): Promise<MembershipAccess> {
  const assigned = await rolesForMembership(tx, membershipId);
  const grants = assigned.map(toGrant);
  return {
    roles: assigned.map(toRoleSummary),
    permissions: effectivePermissions(grants),
    isOwner: grants.some((grant) => grant.systemKey === 'owner'),
  };
}

export async function listRoles(
  tx: TenantTx,
  organizationId: string,
): Promise<(RoleSummary & { memberCount: number })[]> {
  const rows = await tx
    .select({ role: roles, memberCount: count(membershipRoles.membershipId) })
    .from(roles)
    .leftJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
    .where(eq(roles.organizationId, organizationId))
    .groupBy(roles.id)
    .orderBy(sql`${roles.isSystem} desc`, asc(roles.name))
    .limit(500);
  return rows.map((row) => ({ ...toRoleSummary(row.role), memberCount: row.memberCount }));
}

/**
 * Serializes membership/role changes per organization so concurrent requests cannot both pass
 * the "at least one owner" check.
 */
async function lockOrganization(tx: TenantTx, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');
  if (!row) throw new NotFoundError('Organization');
}

async function assertOwnerRemains(tx: TenantTx, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ owners: count() })
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
    .where(
      and(
        eq(membershipRoles.organizationId, organizationId),
        eq(roles.systemKey, 'owner'),
        eq(memberships.status, 'active'),
      ),
    );
  if ((row?.owners ?? 0) < 1) {
    throw new ConflictError('An organization must keep at least one active owner');
  }
}

const roleNameSchema = z.string().trim().min(1).max(100);
const permissionListSchema = z
  .array(z.string().max(100))
  .max(500)
  .transform((list, ctx) => {
    const unique = [...new Set(list)];
    const unknown = unique.filter((permission) => !isPermission(permission));
    if (unknown.length > 0) {
      ctx.addIssue({ code: 'custom', message: `Unknown permissions: ${unknown.join(', ')}` });
      return z.NEVER;
    }
    return unique as Permission[];
  });

export const createRoleInputSchema = z.object({
  name: roleNameSchema,
  description: z.string().trim().max(500).default(''),
  permissions: permissionListSchema,
});

export const updateRoleInputSchema = z
  .object({
    name: roleNameSchema,
    description: z.string().trim().max(500),
    permissions: permissionListSchema,
  })
  .partial();

function assertCanGrantPermissions(actor: MemberActor, permissions: readonly Permission[]): void {
  if (!canGrantRole(actor, { systemKey: null, permissions })) {
    throw new ForbiddenError('You cannot grant permissions that you do not have yourself');
  }
}

async function getRole(tx: TenantTx, organizationId: string, roleId: string): Promise<Role> {
  const [role] = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)));
  if (!role) throw new NotFoundError('Role');
  return role;
}

export async function createRole(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  rawInput: z.input<typeof createRoleInputSchema>,
): Promise<RoleSummary> {
  const input = createRoleInputSchema.parse(rawInput);
  assertCanGrantPermissions(actor, input.permissions);
  try {
    const [role] = await tx
      .insert(roles)
      .values({
        organizationId,
        name: input.name,
        description: input.description,
        permissions: input.permissions,
        isSystem: false,
      })
      .returning();
    if (!role) throw new Error('role insert returned no row');
    return toRoleSummary(role);
  } catch (error) {
    if (isUniqueViolation(error, 'roles_org_name_unique')) {
      throw new ConflictError('A role with this name already exists');
    }
    throw error;
  }
}

export async function updateRole(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  roleId: string,
  rawInput: z.input<typeof updateRoleInputSchema>,
): Promise<{ before: RoleSummary; after: RoleSummary }> {
  const input = updateRoleInputSchema.parse(rawInput);
  const role = await getRole(tx, organizationId, roleId);
  if (role.isSystem) throw new ForbiddenError('System roles cannot be changed');
  // The actor must hold everything the role grants now and everything it would grant after.
  assertCanGrantPermissions(actor, [...effectivePermissions([toGrant(role)])]);
  if (input.permissions) assertCanGrantPermissions(actor, input.permissions);
  try {
    const [updated] = await tx
      .update(roles)
      .set(input)
      .where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
      .returning();
    if (!updated) throw new NotFoundError('Role');
    return { before: toRoleSummary(role), after: toRoleSummary(updated) };
  } catch (error) {
    if (isUniqueViolation(error, 'roles_org_name_unique')) {
      throw new ConflictError('A role with this name already exists');
    }
    throw error;
  }
}

export async function deleteRole(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  roleId: string,
): Promise<RoleSummary> {
  const role = await getRole(tx, organizationId, roleId);
  if (role.isSystem) throw new ForbiddenError('System roles cannot be deleted');
  assertCanGrantPermissions(actor, [...effectivePermissions([toGrant(role)])]);
  const [assigned] = await tx
    .select({ n: count() })
    .from(membershipRoles)
    .where(eq(membershipRoles.roleId, roleId));
  const [invited] = await tx
    .select({ n: count() })
    .from(invitations)
    .where(and(eq(invitations.roleId, roleId), eq(invitations.status, 'pending')));
  if ((assigned?.n ?? 0) > 0 || (invited?.n ?? 0) > 0) {
    throw new ConflictError('Reassign members and pending invitations before deleting this role');
  }
  await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)));
  return toRoleSummary(role);
}

async function getMembership(tx: TenantTx, organizationId: string, membershipId: string) {
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)));
  if (!membership) throw new NotFoundError('Member');
  return membership;
}

async function assertCanManage(
  tx: TenantTx,
  actor: MemberActor,
  membershipId: string,
): Promise<Role[]> {
  const targetRoles = await rolesForMembership(tx, membershipId);
  if (!canManageMember(actor, targetRoles.map(toGrant))) {
    throw new ForbiddenError('You cannot manage a member with more access than you');
  }
  return targetRoles;
}

/**
 * Replaces a member's roles. Rules: actor needs `settings.users.manage` (checked by caller),
 * may not manage more powerful members, may only grant roles within their own permissions,
 * only owners grant/revoke owner, and the organization keeps at least one active owner.
 */
export async function setMemberRoles(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  membershipId: string,
  roleIds: readonly string[],
): Promise<{ before: RoleSummary[]; after: RoleSummary[] }> {
  const unique = [...new Set(roleIds)];
  if (unique.length === 0) {
    throw new ValidationError('Invalid input', [
      { path: 'roleIds', message: 'Assign at least one role' },
    ]);
  }
  await lockOrganization(tx, organizationId);
  await getMembership(tx, organizationId, membershipId);
  const current = await assertCanManage(tx, actor, membershipId);

  const requested = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.organizationId, organizationId), inArray(roles.id, unique)));
  if (requested.length !== unique.length) throw new NotFoundError('Role');

  const currentIds = new Set(current.map((role) => role.id));
  const requestedIds = new Set(requested.map((role) => role.id));
  const added = requested.filter((role) => !currentIds.has(role.id));
  const removed = current.filter((role) => !requestedIds.has(role.id));
  for (const role of [...added, ...removed]) {
    if (!canGrantRole(actor, toGrant(role))) {
      throw new ForbiddenError(`You cannot grant or revoke the ${role.name} role`);
    }
  }

  if (removed.length > 0) {
    await tx.delete(membershipRoles).where(
      and(
        eq(membershipRoles.membershipId, membershipId),
        inArray(
          membershipRoles.roleId,
          removed.map((role) => role.id),
        ),
      ),
    );
  }
  if (added.length > 0) {
    await tx
      .insert(membershipRoles)
      .values(added.map((role) => ({ organizationId, membershipId, roleId: role.id })));
  }
  await assertOwnerRemains(tx, organizationId);
  return { before: current.map(toRoleSummary), after: requested.map(toRoleSummary) };
}

export async function setMemberStatus(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  membershipId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  if (membershipId === actor.membershipId && status === 'suspended') {
    throw new ForbiddenError('You cannot suspend yourself');
  }
  await lockOrganization(tx, organizationId);
  await getMembership(tx, organizationId, membershipId);
  await assertCanManage(tx, actor, membershipId);
  await tx
    .update(memberships)
    .set({ status })
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)));
  await assertOwnerRemains(tx, organizationId);
}

export async function removeMember(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  membershipId: string,
): Promise<{ userId: string }> {
  if (membershipId === actor.membershipId) {
    throw new ForbiddenError('Use "leave organization" to remove yourself');
  }
  await lockOrganization(tx, organizationId);
  const membership = await getMembership(tx, organizationId, membershipId);
  await assertCanManage(tx, actor, membershipId);
  await tx
    .delete(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)));
  await assertOwnerRemains(tx, organizationId);
  return { userId: membership.userId };
}

/** Any member may leave, except the last owner. */
export async function leaveOrganization(
  tx: TenantTx,
  organizationId: string,
  membershipId: string,
): Promise<void> {
  await lockOrganization(tx, organizationId);
  await tx
    .delete(memberships)
    .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)));
  await assertOwnerRemains(tx, organizationId);
}

/** Roles of many memberships at once (for member lists). */
export async function rolesByMembership(
  tx: TenantTx,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<Map<string, { id: string; name: string; systemKey: string | null }[]>> {
  const result = new Map<string, { id: string; name: string; systemKey: string | null }[]>();
  if (membershipIds.length === 0) return result;
  const rows = await tx
    .select({
      membershipId: membershipRoles.membershipId,
      id: roles.id,
      name: roles.name,
      systemKey: roles.systemKey,
    })
    .from(membershipRoles)
    .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
    .where(
      and(
        eq(membershipRoles.organizationId, organizationId),
        inArray(membershipRoles.membershipId, [...membershipIds]),
      ),
    )
    .orderBy(asc(roles.name));
  for (const row of rows) {
    const list = result.get(row.membershipId) ?? [];
    list.push({ id: row.id, name: row.name, systemKey: row.systemKey });
    result.set(row.membershipId, list);
  }
  return result;
}

/** Validates that an actor may invite someone with a given role; returns the role. */
export async function assertCanInviteWithRole(
  tx: TenantTx,
  organizationId: string,
  actor: MemberActor,
  roleId: string,
): Promise<Role> {
  const role = await getRole(tx, organizationId, roleId);
  if (!canGrantRole(actor, toGrant(role))) {
    throw new ForbiddenError(`You cannot invite people with the ${role.name} role`);
  }
  return role;
}

/** Assigns a role during invitation acceptance (system scope; same-tenant FK enforced). */
export async function assignRoleOnJoin(
  tx: SystemTx,
  organizationId: string,
  membershipId: string,
  roleId: string,
): Promise<void> {
  await tx
    .insert(membershipRoles)
    .values({ organizationId, membershipId, roleId })
    .onConflictDoNothing();
}
