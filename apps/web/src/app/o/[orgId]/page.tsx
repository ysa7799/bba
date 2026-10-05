import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BarChart, StatTile } from '@/components/reports/report-parts';
import { Card, PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { OrganizationSummary } from '@/lib/api-types';
import { formatDate } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import type { Dashboard } from '@/lib/report-types';
import { serverApiAsUser, serverGetJson } from '@/lib/server-api';

/** Headline metrics per report on the overview (the full set is on the Reports page). */
const HEADLINES: Record<string, string[]> = {
  sales_pipeline: ['open_value', 'won_value', 'win_rate', 'open_deals'],
  revenue: ['collected', 'outstanding', 'overdue', 'invoices_issued'],
  contacts: ['new_contacts', 'contacts'],
  tasks: ['my_open_tasks', 'overdue_tasks', 'open_tasks', 'completed_tasks'],
  conversations: [
    'open_conversations',
    'unassigned_conversations',
    'messages_received',
    'messages_sent',
  ],
  appointments: [
    'upcoming_7_days',
    'appointments_completed',
    'appointments_no_show',
    'appointments_booked',
  ],
  forms: ['submissions', 'spam_submissions'],
  automation: ['runs_started', 'runs_failed', 'success_rate', 'runs_completed'],
};
const MAX_TILES = 4;

function headlines(report: string, metrics: Dashboard['widgets'][number]['metrics']) {
  const keys = HEADLINES[report];
  const picked = keys
    ? keys.flatMap((key) => metrics.filter((metric) => metric.key === key))
    : metrics;
  return picked.slice(0, MAX_TILES);
}

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const response = await serverApiAsUser(`/app/orgs/${orgId}`);
  if (response.status === 404 || response.status === 401) notFound();
  if (!response.ok) throw new Error(`Failed to load organization (${response.status})`);
  const { organization } = (await response.json()) as { organization: OrganizationSummary };
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  const dashboard = access?.permissions.includes('reports.read')
    ? await serverGetJson<Dashboard>(`/app/orgs/${orgId}/reports/dashboard`)
    : null;

  const rows: [string, string][] = [
    [m.app.overview.handle, organization.slug],
    [m.app.overview.country, organization.countryCode],
    [m.app.overview.currency, organization.defaultCurrency],
    [m.app.overview.timezone, organization.timezone],
  ];

  return (
    <>
      <PageHeader title={organization.name} />
      {dashboard && dashboard.widgets.length > 0 ? (
        <section className="mb-8 space-y-4" data-testid="dashboard">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">{m.reports.dashboard}</h2>
            <p className="text-xs text-slate-500">
              {format(m.reports.dashboardHint, {
                from: formatDate(dashboard.range.from),
                to: formatDate(dashboard.range.to),
                timezone: dashboard.range.timezone,
              })}
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {dashboard.widgets.map((widget) => {
              const series = widget.series[0];
              return (
                <Card key={widget.report} className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      {(m.reports.names as Record<string, string>)[widget.report] ?? widget.report}
                    </h3>
                    <Link
                      href={`/o/${orgId}/reports?report=${widget.report}`}
                      className="text-xs font-medium text-brand-600 hover:underline"
                    >
                      {m.reports.openReport}
                    </Link>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {headlines(widget.report, widget.metrics).map((metric) => (
                      <StatTile
                        key={`${metric.key}-${metric.currency ?? ''}`}
                        m={m}
                        metric={metric}
                      />
                    ))}
                  </div>
                  {series ? (
                    <BarChart
                      m={m}
                      series={series}
                      granularity={dashboard.range.granularity}
                      compact
                    />
                  ) : null}
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}
      <Card className="max-w-2xl">
        <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold">
          {m.app.overview.details}
        </h2>
        <dl className="divide-y divide-slate-100" data-testid="organization-details">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-3 gap-4 px-5 py-3 text-sm">
              <dt className="text-slate-500">{label}</dt>
              <dd className="col-span-2 text-slate-900">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}
