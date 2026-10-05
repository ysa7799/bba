import { recordAudit } from '@businessos/audit';
import { subscribeToDefaultPlan } from '@businessos/billing';
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
import { auditContext } from '../../lib/http';
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
    const { organization } = await createOrganization(app.deps.db.db, auth.user.id, input, {
      correlationId: request.id,
      hooks: [
        (tx, created) =>
          recordAudit(tx, auditContext(request), {
            organizationId: created.organization.id,
            action: 'organization.created',
            target: { type: 'organization', id: created.organization.id },
            metadata: { name: created.organization.name },
          }),
        // New organizations start on the platform's default plan (if one is configured).
        async (tx, created) => {
          await subscribeToDefaultPlan(tx, created.organization.id, request.id);
        },
      ],
    });
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
          const { before, after, changedFields } = await updateOrganization(
            tx,
            tenant.organizationId,
            patch,
            { userId: tenant.userId, correlationId: request.id },
          );
          if (changedFields.length > 0) {
            await recordAudit(tx, auditContext(request), {
              organizationId: tenant.organizationId,
              action: 'organization.updated',
              target: { type: 'organization', id: tenant.organizationId },
              metadata: {
                changes: Object.fromEntries(
                  changedFields.map((field) => [
                    field,
                    {
                      from: before[field as keyof typeof before],
                      to: after[field as keyof typeof after],
                    },
                  ]),
                ),
              },
            });
          }
          return { organization: toOrganizationSummary(after) };
        });
      });

      scoped.patch('/settings', async (request) => {
        const tenant = requirePermission(request, 'organization.update');
        const patch = parseInput(settingsPatchSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => {
          const settings = await updateOrganizationSettings(
            tx,
            tenant.organizationId,
            patch,
            tenant.userId,
          );
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'organization.settings_updated',
            target: { type: 'organization', id: tenant.organizationId },
            metadata: { keys: Object.keys(patch) },
          });
          return { settings };
        });
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
        await withTenant(db(), tenantScope(tenant), async (tx) => {
          await leaveOrganization(tx, tenant.organizationId, actorOf(tenant, request));
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'member.left',
            target: { type: 'membership', id: tenant.membershipId },
          });
        });
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
          const { before, after } = await setMemberRoles(
            tx,
            tenant.organizationId,
            actorOf(tenant, request),
            id,
            roleIds,
          );
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'member.roles_changed',
            target: { type: 'membership', id },
            metadata: {
              before: before.map((role) => role.name),
              after: after.map((role) => role.name),
            },
          });
          return { roles: after };
        });
      });

      scoped.patch('/members/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const { status } = parseInput(memberStatusSchema, request.body);
        await withTenant(db(), tenantScope(tenant), async (tx) => {
          await setMemberStatus(tx, tenant.organizationId, actorOf(tenant, request), id, status);
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: status === 'suspended' ? 'member.suspended' : 'member.reactivated',
            target: { type: 'membership', id },
          });
        });
        return reply.status(204).send();
      });

      scoped.delete('/members/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.users.manage');
        const { id } = parseInput(idParamSchema, request.params);
        await withTenant(db(), tenantScope(tenant), async (tx) => {
          const { userId } = await removeMember(
            tx,
            tenant.organizationId,
            actorOf(tenant, request),
            id,
          );
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'member.removed',
            target: { type: 'membership', id },
            metadata: { userId },
          });
        });
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
        const role = await withTenant(db(), tenantScope(tenant), async (tx) => {
          const created = await createRole(
            tx,
            tenant.organizationId,
            actorOf(tenant, request),
            input,
          );
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'role.created',
            target: { type: 'role', id: created.id },
            metadata: { name: created.name, permissions: created.permissions },
          });
          return created;
        });
        return reply.status(201).send({ role });
      });

      scoped.patch('/roles/:id', async (request) => {
        const tenant = requirePermission(request, 'settings.roles.manage');
        const { id } = parseInput(idParamSchema, request.params);
        const input = parseInput(updateRoleInputSchema, request.body);
        return withTenant(db(), tenantScope(tenant), async (tx) => {
          const { before, after } = await updateRole(
            tx,
            tenant.organizationId,
            actorOf(tenant, request),
            id,
            input,
          );
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'role.updated',
            target: { type: 'role', id },
            metadata: {
              before: { name: before.name, permissions: before.permissions },
              after: { name: after.name, permissions: after.permissions },
            },
          });
          return { role: after };
        });
      });

      scoped.delete('/roles/:id', async (request, reply) => {
        const tenant = requirePermission(request, 'settings.roles.manage');
        const { id } = parseInput(idParamSchema, request.params);
        await withTenant(db(), tenantScope(tenant), async (tx) => {
          const deleted = await deleteRole(tx, tenant.organizationId, actorOf(tenant, request), id);
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'role.deleted',
            target: { type: 'role', id },
            metadata: { name: deleted.name, permissions: deleted.permissions },
          });
        });
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
        const created = await withTenant(db(), tenantScope(tenant), async (tx) => {
          const invitation = await createInvitation(tx, app.deps.authConfig, {
            organizationId: tenant.organizationId,
            email: input.email,
            roleId: input.roleId,
            invitedBy: actorOf(tenant, request),
          });
          await recordAudit(tx, auditContext(request), {
            organizationId: tenant.organizationId,
            action: 'member.invited',
            target: { type: 'invitation', id: invitation.invitation.id },
            metadata: { email: invitation.invitation.email, roleId: input.roleId },
          });
          return invitation;
        });
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
        const revoked = await withTenant(db(), tenantScope(tenant), async (tx) => {
          const rows = await tx
            .update(invitations)
            .set({ status: 'revoked', revokedAt: new Date() })
            .where(
              and(
                eq(invitations.id, id),
                eq(invitations.organizationId, tenant.organizationId),
                eq(invitations.status, 'pending'),
              ),
            )
            .returning({ id: invitations.id, email: invitations.email });
          if (rows.length > 0) {
            await recordAudit(tx, auditContext(request), {
              organizationId: tenant.organizationId,
              action: 'member.invitation_revoked',
              target: { type: 'invitation', id },
              metadata: { email: rows[0]?.email },
            });
          }
          return rows;
        });
        if (revoked.length === 0) throw new NotFoundError('Invitation');
        return reply.status(204).send();
      });
    },
    { prefix: '/:orgId' },
  );
}
