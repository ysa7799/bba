import { setActiveOrganization } from '@businessos/auth';
import { withTenant } from '@businessos/database';
import {
  createOrganization,
  createOrganizationInputSchema,
  getOrganization,
  getOrganizationSettings,
  listMembers,
  listOrganizationsForUser,
  toOrganizationSummary,
} from '@businessos/organizations';
import { paginationQuerySchema } from '@businessos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';
import { requireTenant, resolveTenant } from '../../plugins/tenant';

const listMembersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(100).optional(),
});

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

      scoped.get('/', async (request) => {
        const tenant = requireTenant(request);
        return withTenant(
          app.deps.db.db,
          { organizationId: tenant.organizationId, userId: tenant.userId },
          async (tx) => ({
            organization: toOrganizationSummary(await getOrganization(tx, tenant.organizationId)),
            settings: await getOrganizationSettings(tx, tenant.organizationId),
          }),
        );
      });

      scoped.get('/members', async (request) => {
        const tenant = requireTenant(request);
        const query = parseInput(listMembersQuerySchema, request.query);
        return withTenant(
          app.deps.db.db,
          { organizationId: tenant.organizationId, userId: tenant.userId },
          (tx) => listMembers(tx, tenant.organizationId, query),
        );
      });
    },
    { prefix: '/:orgId' },
  );
}
