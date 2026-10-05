import { createInvitation, setActiveOrganization } from '@businessos/auth';
import { invitations, roles, users, withTenant } from '@businessos/database';
import {
  createOrganization,
  createOrganizationInputSchema,
  createRole,
  createRoleInputSchema,
  deleteRole,
  getOrganization,
  getOrganizationSettings,
  leaveOrganization,
  listMembers,
  listOrganizationsForUser,
  listRoles,
  removeMember,
  setMemberRoles,
  setMemberStatus,
  toOrganizationSummary,
  updateOrganization,
  updateOrganizationInputSchema,
  updateOrganizationSettings,
  updateRole,
  updateRoleInputSchema,
} from '@businessos/organizations';
import { PERMISSION_DEFINITIONS } from '@businessos/permissions';
import { NotFoundError, paginationQuerySchema } from '@businessos/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';
import {
  actorOf,
  requirePermission,
  requireTenant,
  resolveTenant,
  tenantScope,
} from '../../plugins/tenant';

const listMembersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
});
const idParamSchema = z.object({ id: z.uuid() });
const memberRolesSchema = z.object({ roleIds: z.array(z.uuid()).min(1).max(20) });
const memberStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
const inviteSchema = z.object({ email: z.string().max(320), roleId: z.uuid() });
const settingsPatchSchema = z.record(z.string().max(100), z.unknown());

export function organizationRoutes(app: FastifyInstance): void {
  app.get('/', async (request) => {
    const auth = requireAuth(request);
    const organizations = await listOrganizationsForUser(app.deps.db.db, auth.user.id);
    return { data: organizations.map((entry) => entry.organization) };
  });

  app.post('/', async (request, reply) => {
    const auth = requireAuth(request);
    await app.rateLimiter.consume('createOrganizationUser', auth.user.id);
    const input = parseInput(createOrganizationInputSchema, request.body);
    const { organization } = await createOrganization(app.deps.db.db, auth.user.id, input);
    await setActiveOrganization(app.deps.db.db, auth, organization.id);
    return reply.status(201).send({ organization: toOrganizationSummary(organization) });
  });

  // Everything below is tenant-scoped: membership is resolved before any handler runs.
  void app.register(
    (scoped) => {
      scoped.addHook('preHandler', async (request) => {
        await resolveTenant(request);
      });

      const db = () => app.deps.db.db;

      scoped.get('/', async (request) => {
        const tenant = requireTenant(request);
        return withTenant(db(), tenantScope(tenant), async (tx) => ({
          organization: toOrganizationSummary(await getOrganization(tx, tenant.organizationId)),
          settings: await getOrganizationSettings(tx, tenant.organizationId),
        }));
      });

      scoped.patch('/', async (request) => {
        const tenant = requirePermission(request, 'organization.update');
        const patch = parseInput(updateOrganizationInputSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => {
          const { after } = await updateOrganization(tx, tenant.organizationId, patch);
          return { organization: toOrganizationSummary(after) };
        });
      });

      scoped.patch('/settings', async (request) => {
        const tenant = requirePermission(request, 'organization.update');
        const patch = parseInput(settingsPatchSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => ({
          settings: await updateOrganizationSettings(
            tx,
            tenant.organizationId,
            patch,
            tenant.userId,
          ),
        }));
      });

      // The caller's own access, used by the UI to show or hide controls.
      scoped.get('/access', (request) => {
        const tenant = requireTenant(request);
        return {
          membershipId: tenant.membershipId,
          roles: tenant.roles,
          permissions: [...tenant.permissions].sort(),
          isOwner: tenant.isOwner,
        };
      });

      scoped.get('/permissions', () => ({
        data: PERMISSION_DEFINITIONS.map(({ key, module, label, description }) => ({
          key,
          module,
          label,
          description,
        })),
      }));

      scoped.post('/leave', async (request, reply) => {
        const tenant = requireTenant(request);
        await withTenant(db(), tenantScope(tenant), (tx) =>
          leaveOrganization(tx, tenant.organizationId, tenant.membershipId),
        );
        return reply.status(204).send();
      });

      // Members
      scoped.get('/members', async (request) => {
        const tenant = requireTenant(request);
        const query = parseInput(listMembersQuerySchema, request.query);
        return withTenant(db(), tenantScope(tenant), (tx) =>
          listMembers(tx, tenant.organizationId, query),
        );
      });

      scoped.put('/members/:id/roles', async (request) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const { roleIds } = parseInput(memberRolesSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => {
          const { after } = await setMemberRoles(
            tx,
            tenant.organizationId,
            actorOf(tenant),
            id,
            roleIds,
          );
          return { roles: after };
        });
      });

      scoped.patch('/members/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const { status } = parseInput(memberStatusSchema, request.body);
        await withTenant(db(), tenantScope(tenant), (tx) =>
          setMemberStatus(tx, tenant.organizationId, actorOf(tenant), id, status),
        );
        return reply.status(204).send();
      });

      scoped.delete('/members/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        await withTenant(db(), tenantScope(tenant), (tx) =>
          removeMember(tx, tenant.organizationId, actorOf(tenant), id),
        );
        return reply.status(204).send();
      });

      // Roles
      scoped.get('/roles', async (request) => {
        const tenant = requireTenant(request);
        return withTenant(db(), tenantScope(tenant), async (tx) => ({
          data: await listRoles(tx, tenant.organizationId),
        }));
      });

      scoped.post('/roles', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.roles.manage');
        const input = parseInput(createRoleInputSchema, request.body);
        const role = await withTenant(db(), tenantScope(tenant), (tx) =>
          createRole(tx, tenant.organizationId, actorOf(tenant), input),
        );
        return reply.status(201).send({ role });
      });

      scoped.patch('/roles/:id', async (request) => {
        const tenant = requirePermission(request, 'settings.roles.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const input = parseInput(updateRoleInputSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => {
          const { after } = await updateRole(tx, tenant.organizationId, actorOf(tenant), id, input);
          return { role: after };
        });
      });

      scoped.delete('/roles/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.roles.manage');
        const { id } = parseInput(idParamSchema, request.params);
        await withTenant(db(), tenantScope(tenant), (tx) =>
          deleteRole(tx, tenant.organizationId, actorOf(tenant), id),
        );
        return reply.status(204).send();
      });

      // Invitations
      scoped.get('/invitations', async (request) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        return withTenant(db(), tenantScope(tenant), async (tx) => ({
          data: await tx
            .select({
              id: invitations.id,
              email: invitations.email,
              roleId: invitations.roleId,
              roleName: roles.name,
              invitedBy: users.name,
              expiresAt: invitations.expiresAt,
              createdAt: invitations.createdAt,
            })
            .from(invitations)
            .innerJoin(roles, eq(roles.id, invitations.roleId))
            .leftJoin(users, eq(users.id, invitations.invitedByUserId))
            .where(
              and(
                eq(invitations.organizationId, tenant.organizationId),
                eq(invitations.status, 'pending'),
                sql`${invitations.expiresAt} > now()`,
              ),
            )
            .orderBy(desc(invitations.createdAt))
            .limit(200),
        }));
      });

      scoped.post('/invitations', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        await app.rateLimiter.consume('invitationCreateOrg', tenant.organizationId);
        const input = parseInput(inviteSchema, request.body);
        const created = await withTenant(db(), tenantScope(tenant), (tx) =>
          createInvitation(tx, app.deps.authConfig, {
            organizationId: tenant.organizationId,
            email: input.email,
            roleId: input.roleId,
            invitedBy: actorOf(tenant),
          }),
        );
        await app.deps.mailer.send(created.email);
        return reply.status(201).send({
          invitation: {
            id: created.invitation.id,
            email: created.invitation.email,
            roleId: created.invitation.roleId,
            expiresAt: created.invitation.expiresAt,
          },
        });
      });

      scoped.delete('/invitations/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const revoked = await withTenant(db(), tenantScope(tenant), (tx) =>
          tx
            .update(invitations)
            .set({ status: 'revoked', revokedAt: new Date() })
            .where(
              and(
                eq(invitations.id, id),
                eq(invitations.organizationId, tenant.organizationId),
                eq(invitations.status, 'pending'),
              ),
            )
            .returning({ id: invitations.id }),
        );
        if (revoked.length === 0) throw new NotFoundError('Invitation');
        return reply.status(204).send();
      });
    },
    { prefix: '/:orgId' },
  );
}
