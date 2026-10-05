import { auditQuerySchema, listAuditLogs } from '@businessos/audit';
import { withTenant } from '@businessos/database';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../../lib/validation';
import { requirePermission, resolveTenant, tenantScope } from '../../plugins/tenant';

/** `/app/orgs/:orgId/audit-logs` — read-only, newest first, `audit.read` required. */
export function auditRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  app.get('/', async (request) => {
    const tenant = requirePermission(request, 'audit.read');
    const query = parseInput(auditQuerySchema, request.query);
    return withTenant(app.deps.db.db, tenantScope(tenant), (tx) =>
      listAuditLogs(tx, tenant.organizationId, query),
    );
  });
}
