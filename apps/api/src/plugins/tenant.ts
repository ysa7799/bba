import type { Organization } from '@businessos/database';
import { resolveMembership } from '@businessos/organizations';
import { isUuid, NotFoundError } from '@businessos/shared';
import type { FastifyRequest } from 'fastify';
import { requireAuth } from './session';

export interface TenantContext {
  organizationId: string;
  organization: Organization;
  userId: string;
  membershipId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext | null;
  }
}

/**
 * Resolves the tenant for `/app/orgs/:orgId/*`. The `orgId` path parameter is only a selector:
 * access comes from the signed-in user's active membership. Non-members, unknown and inactive
 * organizations all produce the same 404 so organization IDs cannot be probed.
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
  };
  request.tenant = tenant;
  return tenant;
}

/** Returns the tenant resolved by the org-scoped route plugin. */
export function requireTenant(request: FastifyRequest): TenantContext {
  if (request.tenant === null) throw new NotFoundError('Organization');
  return request.tenant;
}
