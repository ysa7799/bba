import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { BarChart, DataTable, StatTile } from '@/components/reports/report-parts';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { inputClass } from '@/components/ui/field';
import { getMessages } from '@/i18n';
import type { ApiErrorBody } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { pickString } from '@/lib/navigation';
import { getOrgAccess } from '@/lib/org-data';
import type { ReportResult } from '@/lib/report-types';
import { serverApiAsUser, serverGetJson } from '@/lib/server-api';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('reports.read')) {
    return <CrmForbidden title={m.reports.title} message={m.reports.forbidden} />;
  }
  const list = await serverGetJson<{ reports: string[] }>(`/app/orgs/${orgId}/reports`);
  if (!list) notFound();
  if (list.reports.length === 0) {
    return (
      <>
        <PageHeader title={m.reports.title} />
        <EmptyState title={m.reports.noReports} />
      </>
    );
  }
  const requested = pickString(query.report);
  const key = requested && list.reports.includes(requested) ? requested : (list.reports[0] ?? '');
  const search = new URLSearchParams();
  const from = pickString(query.from);
  const to = pickString(query.to);
  const granularity = pickString(query.granularity);
  if (from && DATE.test(from)) search.set('from', from);
  if (to && DATE.test(to)) search.set('to', to);
  if (granularity && ['day', 'week', 'month'].includes(granularity)) {
    search.set('granularity', granularity);
  }
  const response = await serverApiAsUser(`/app/orgs/${orgId}/reports/${key}?${search.toString()}`);
  if (response.status === 404 || response.status === 401) notFound();
  let report: ReportResult | null = null;
  let problem: string | null = null;
  if (response.ok) {
    report = ((await response.json()) as { report: ReportResult }).report;
  } else if (response.status === 400) {
    const { error } = (await response.json()) as ApiErrorBody;
    problem = [error.message, ...(error.details ?? []).map((detail) => detail.message)].join(' — ');
  } else {
    throw new Error(`Request failed (${response.status})`);
  }
  const base = `/o/${orgId}/reports`;
  const tabQuery = (tab: string) => {
    const next = new URLSearchParams(search);
    next.set('report', tab);
    return `${base}?${next.toString()}`;
  };
  const csvQuery = new URLSearchParams(
    report
      ? { from: report.range.from, to: report.range.to, granularity: report.range.granularity }
      : {},
  );

  return (
    <>
      <PageHeader
        title={m.reports.title}
        actions={
          report ? (
            <a
              href={`/api/app/orgs/${orgId}/reports/${key}/export.csv?${csvQuery.toString()}`}
              className="inline-flex h-10 items-center rounded-md px-4 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              {m.reports.download}
            </a>
          ) : null
        }
      />
      <nav aria-label={m.reports.title} className="mb-4 flex flex-wrap gap-2 text-sm">
        {list.reports.map((tab) => (
          <Link
            key={tab}
            href={tabQuery(tab)}
            aria-current={tab === key ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5',
              tab === key ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {(m.reports.names as Record<string, string>)[tab] ?? tab}
          </Link>
        ))}
      </nav>
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3" data-testid="report-range">
        <input type="hidden" name="report" value={key} />
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-slate-800">{m.reports.from}</span>
          <input
            type="date"
            name="from"
            defaultValue={report?.range.from ?? from ?? ''}
            className={inputClass}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-slate-800">{m.reports.to}</span>
          <input
            type="date"
            name="to"
            defaultValue={report?.range.to ?? to ?? ''}
            className={inputClass}
          />
        </label>
        <label className="space-y-1.5 text-sm">
          <span className="block font-medium text-slate-800">{m.reports.granularity}</span>
          <select
            name="granularity"
            defaultValue={report?.range.granularity ?? granularity ?? 'day'}
            className={inputClass}
          >
            {(['day', 'week', 'month'] as const).map((value) => (
              <option key={value} value={value}>
                {m.reports.granularities[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          {m.reports.apply}
        </button>
      </form>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {report ? (
        <div className="space-y-6" data-testid="report">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {report.metrics.map((metric) => (
              <StatTile key={`${metric.key}-${metric.currency ?? ''}`} m={m} metric={metric} />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {report.series.map((series) => (
              <div
                key={`${series.key}-${series.currency ?? ''}`}
                className="rounded-lg border border-slate-200 bg-white p-4"
              >
                <BarChart m={m} series={series} granularity={report.range.granularity} />
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {report.tables.map((table) => (
              <DataTable key={table.key} m={m} table={table} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
