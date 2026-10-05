import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { OrganizationSummary } from '@/lib/api-types';
import { serverApiAsUser } from '@/lib/server-api';

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const response = await serverApiAsUser(`/app/orgs/${orgId}`);
  if (response.status === 404 || response.status === 401) notFound();
  if (!response.ok) throw new Error(`Failed to load organization (${response.status})`);
  const { organization } = (await response.json()) as { organization: OrganizationSummary };
  const m = getMessages('en');

  const rows: [string, string][] = [
    [m.app.overview.handle, organization.slug],
    [m.app.overview.country, organization.countryCode],
    [m.app.overview.currency, organization.defaultCurrency],
    [m.app.overview.timezone, organization.timezone],
  ];

  return (
    <>
      <PageHeader title={organization.name} />
      <Card className="max-w-2xl">
        <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold">
          {m.app.overview.details}
        </h2>
        <dl className="divide-y divide-slate-100">
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
