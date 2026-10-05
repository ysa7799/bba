import type { Organization } from '@businessos/database';
import { resolveMembership, type MemberActor, type RoleSummary } from '@businessos/organizations';
import type { Permission } from '@businessos/permissions';
import { ForbiddenError, isUuid, NotFoundError } from '@businessos/shared';
import type { FastifyRequest } from 'fastify';
import { requireAuth } from './session';

export interface TenantContext {
  organizationId: string;
  organization: Organization;
  userId: string;
  membershipId: string;
  roles: RoleSummary[];
  permissions: ReadonlySet<Permission>;
  isOwner: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext | null;
  }
}

/**
 * Resolves the tenant for `/app/orgs/:orgId/*`. The `orgId` path parameter is only a selector:
 * access comes from the signed-in user's active membership. Non-members, unknown and inactive
 * organizations all produce the same 404 so organization IDs cannot be probed. Permissions are
 * re-evaluated on every request, so role changes take effect immediately.
 */
export async function resolveTenant(request: FastifyRequest): Promise<TenantContext> {
  const auth = requireAuth(request);
  const { orgId } = request.params as { orgId?: unknown };
  if (!isUuid(orgId)) throw new NotFoundError('Organization');
  const resolved = await resolveMembership(request.server.deps.db.db, auth.user.id, orgId);
  if (!resolved) throw new NotFoundError('Organization');
  const tenant: TenantContext = {
    organizationId: resolved.organization.id,
    organization: resolved.organization,
    userId: auth.user.id,
    membershipId: resolved.membership.id,
    roles: resolved.access.roles,
    permissions: resolved.access.permissions,
    isOwner: resolved.access.isOwner,
  };
  request.tenant = tenant;
  return tenant;
}

/** Returns the tenant resolved by the org-scoped route plugin. */
export function requireTenant(request: FastifyRequest): TenantContext {
  if (request.tenant === null) throw new NotFoundError('Organization');
  return request.tenant;
}

/**
 * Server-side authorization check. Members of the organization without the permission get 403
 * (they already know the organization exists); everyone else never reaches this point (404).
 */
export function requirePermission(request: FastifyRequest, permission: Permission): TenantContext {
  const tenant = requireTenant(request);
  if (!tenant.permissions.has(permission)) {
    throw new ForbiddenError();
  }
  return tenant;
}

export function actorOf(tenant: TenantContext): MemberActor {
  return {
    userId: tenant.userId,
    membershipId: tenant.membershipId,
    permissions: tenant.permissions,
    isOwner: tenant.isOwner,
  };
}

export function tenantScope(tenant: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: tenant.organizationId, userId: tenant.userId };
}
