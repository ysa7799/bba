import { recordAudit } from '@businessos/audit';
import { withTenant } from '@businessos/database';
import {
  availableReports,
  getDashboard,
  reportRangeSchema,
  reportToCsv,
  runReport,
  type ReportContext,
} from '@businessos/reporting';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requirePermission,
  requireTenant,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';

const keyParams = z.object({ key: z.string().regex(/^[a-z_]{1,40}$/) });

function context(tenant: TenantContext): ReportContext {
  return {
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    timezone: tenant.organization.timezone,
    defaultCurrency: tenant.organization.defaultCurrency,
    permissions: tenant.permissions,
  };
}

/**
 * `/app/orgs/:orgId/reports/*` — dashboards and reports. Every report needs `reports.read` and
 * read access to the data it summarizes (checked again by the reporting service).
 */
export function reportRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  /** The reports this person may open (empty without `reports.read`). */
  app.get('/', (request) => {
    const tenant = requireTenant(request);
    return { reports: availableReports(context(tenant)) };
  });

  app.get('/dashboard', async (request) => {
    const tenant = requirePermission(request, 'reports.read');
    await app.rateLimiter.consume('reportRunUser', tenant.userId);
    return withTenant(db(), tenantScope(tenant), (tx) => getDashboard(tx, context(tenant)));
  });

  app.get('/:key', async (request) => {
    const tenant = requirePermission(request, 'reports.read');
    const { key } = parseInput(keyParams, request.params);
    const range = parseInput(reportRangeSchema, request.query);
    await app.rateLimiter.consume('reportRunUser', tenant.userId);
    const report = await withTenant(db(), tenantScope(tenant), (tx) =>
      runReport(tx, context(tenant), key, range),
    );
    return { report };
  });

  /** The same report as a CSV download (audited: it may contain customer names). */
  app.get('/:key/export.csv', async (request, reply) => {
    const tenant = requirePermission(request, 'reports.read');
    const { key } = parseInput(keyParams, request.params);
    const range = parseInput(reportRangeSchema, request.query);
    await app.rateLimiter.consume('reportExportUser', tenant.userId);
    const report = await withTenant(db(), tenantScope(tenant), async (tx) => {
      const result = await runReport(tx, context(tenant), key, range);
      await recordAudit(tx, auditContext(request), {
        organizationId: tenant.organizationId,
        action: 'reports.exported',
        target: { type: 'report', id: result.key },
        metadata: { from: result.range.from, to: result.range.to },
      });
      return result;
    });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${report.key}-${report.range.from}-${report.range.to}.csv"`,
      )
      .send(reportToCsv(report));
  });
}
