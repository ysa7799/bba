import { withTenant } from '@businessos/database';
import {
  countUnread,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  updatePreferences,
} from '@businessos/notifications';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';
import { requireTenant, resolveTenant, tenantScope } from '../../plugins/tenant';

const idParams = z.object({ id: z.uuid() });

/**
 * `/app/orgs/:orgId/notifications` — the signed-in member's own notifications and channel
 * choices. Nobody else's are reachable (filters and row-level security).
 */
export function notificationRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  app.get('/', async (request) => {
    const tenant = requireTenant(request);
    return withTenant(db(), tenantScope(tenant), (tx) =>
      listNotifications(
        tx,
        tenantScope(tenant),
        request.query as Parameters<typeof listNotifications>[2],
      ),
    );
  });

  app.get('/unread-count', async (request) => {
    const tenant = requireTenant(request);
    return {
      unread: await withTenant(db(), tenantScope(tenant), (tx) =>
        countUnread(tx, tenantScope(tenant)),
      ),
    };
  });

  app.post('/:id/read', async (request) => {
    const tenant = requireTenant(request);
    const { id } = parseInput(idParams, request.params);
    return {
      notification: await withTenant(db(), tenantScope(tenant), (tx) =>
        markRead(tx, tenantScope(tenant), id),
      ),
    };
  });

  app.post('/read-all', async (request) => {
    const tenant = requireTenant(request);
    return {
      updated: await withTenant(db(), tenantScope(tenant), (tx) =>
        markAllRead(tx, tenantScope(tenant)),
      ),
    };
  });

  app.get('/preferences', async (request) => {
    const tenant = requireTenant(request);
    return {
      preferences: await withTenant(db(), tenantScope(tenant), (tx) =>
        getPreferences(tx, tenantScope(tenant), tenant.permissions),
      ),
    };
  });

  app.put('/preferences', async (request) => {
    const tenant = requireTenant(request);
    return {
      preferences: await withTenant(db(), tenantScope(tenant), (tx) =>
        updatePreferences(
          tx,
          tenantScope(tenant),
          tenant.permissions,
          request.body as Parameters<typeof updatePreferences>[3],
        ),
      ),
    };
  });
}
