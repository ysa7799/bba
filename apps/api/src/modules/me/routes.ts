import { changePassword, setActiveOrganization } from '@businessos/auth';
import { listOrganizationsForUser } from '@businessos/organizations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';

const activeOrganizationSchema = z.object({ organizationId: z.uuid() });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().max(1024),
});

export function meRoutes(app: FastifyInstance): void {
  app.get('/', async (request) => {
    const auth = requireAuth(request);
    const organizations = await listOrganizationsForUser(app.deps.db.db, auth.user.id);
    const activeOrganizationId = organizations.some(
      (entry) => entry.organization.id === auth.activeOrganizationId,
    )
      ? auth.activeOrganizationId
      : null;
    return {
      user: auth.user,
      organizations: organizations.map((entry) => entry.organization),
      activeOrganizationId,
    };
  });

  app.post('/active-organization', async (request, reply) => {
    const auth = requireAuth(request);
    const { organizationId } = parseInput(activeOrganizationSchema, request.body);
    await setActiveOrganization(app.deps.db.db, auth, organizationId);
    return reply.status(204).send();
  });

  app.post('/password', async (request, reply) => {
    const auth = requireAuth(request);
    await app.rateLimiter.consume('changePasswordUser', auth.user.id);
    const input = parseInput(changePasswordSchema, request.body);
    await changePassword(
      { db: app.deps.db.db, config: app.deps.authConfig, mailer: app.deps.mailer },
      auth.user.id,
      auth.sessionId,
      input,
    );
    return reply.status(204).send();
  });
}
