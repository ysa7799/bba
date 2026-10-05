import type { TenantTx } from '@businessos/database';
import type { Permission } from '@businessos/permissions';
import { ForbiddenError, NotFoundError } from '@businessos/shared';
import { localDate, resolveRange, type ReportRangeInput } from './range';
import {
  appointmentsReport,
  automationReport,
  contacts,
  conversationsReport,
  formsReport,
  revenue,
  salesPipeline,
  tasks,
  type ReportRunner,
} from './reports';
import { can, rangeView, type ReportContext, type ReportResult } from './result';

/** Every report needs `reports.read` plus read access to the data it summarizes. */
export const REPORTS = {
  sales_pipeline: { permission: 'crm.deal.read', run: salesPipeline },
  revenue: { permission: 'commerce.invoice.read', run: revenue },
  contacts: { permission: 'crm.contact.read', run: contacts },
  tasks: { permission: 'crm.task.read', run: tasks },
  conversations: { permission: 'communications.read', run: conversationsReport },
  appointments: { permission: 'calendar.appointment.read', run: appointmentsReport },
  forms: { permission: 'forms.submission.read', run: formsReport },
  automation: { permission: 'automation.workflow.read', run: automationReport },
} as const satisfies Record<string, { permission: Permission; run: ReportRunner }>;

export type ReportKey = keyof typeof REPORTS;
export const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[];

export function isReportKey(value: unknown): value is ReportKey {
  return typeof value === 'string' && Object.hasOwn(REPORTS, value);
}

/** Reports this person may open (empty without `reports.read`). */
export function availableReports(ctx: ReportContext): ReportKey[] {
  if (!can(ctx, 'reports.read')) return [];
  return REPORT_KEYS.filter((key) => can(ctx, REPORTS[key].permission));
}

export async function runReport(
  tx: TenantTx,
  ctx: ReportContext,
  key: string,
  rangeInput: ReportRangeInput,
  now: Date = new Date(),
): Promise<ReportResult> {
  if (!isReportKey(key)) throw new NotFoundError('Report');
  // Checked here as well as in the route: reports are aggregates of data the caller must be
  // allowed to read in the first place.
  if (!availableReports(ctx).includes(key)) throw new ForbiddenError();
  const range = await resolveRange(tx, ctx.timezone, rangeInput, now);
  const result = await REPORTS[key].run(tx, ctx, range, { detail: true, now });
  return { key, range: rangeView(range), ...result };
}

export interface DashboardWidget {
  report: ReportKey;
  metrics: ReportResult['metrics'];
  series: ReportResult['series'];
}

export interface Dashboard {
  range: ReportResult['range'];
  widgets: DashboardWidget[];
}

/**
 * The overview: this month so far (organization time zone) for every report the person may
 * open. Reports they cannot open are left out entirely, not shown empty.
 */
export async function getDashboard(
  tx: TenantTx,
  ctx: ReportContext,
  now: Date = new Date(),
): Promise<Dashboard> {
  const today = localDate(now, ctx.timezone);
  const from = `${today.slice(0, 8)}01`;
  const range = await resolveRange(tx, ctx.timezone, { from, to: today, granularity: 'day' }, now);
  const widgets: DashboardWidget[] = [];
  for (const key of availableReports(ctx)) {
    const result = await REPORTS[key].run(tx, ctx, range, { detail: false, now });
    widgets.push({ report: key, metrics: result.metrics, series: result.series.slice(0, 2) });
  }
  return { range: rangeView(range), widgets };
}
