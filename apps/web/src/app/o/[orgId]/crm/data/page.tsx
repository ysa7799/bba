import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { ExportsPanel } from '@/components/crm/exports-panel';
import { ImportWizard } from '@/components/crm/import-wizard';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { ExportSummary, ImportDetail } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function DataPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  const canImport = access.permissions.includes('crm.data.import');
  const canExport = access.permissions.includes('crm.data.export');
  if (!canImport && !canExport) return <CrmForbidden title={m.crm.data.title} />;
  const [imports, exports] = await Promise.all([
    canImport
      ? serverGetJson<{ data: ImportDetail[] }>(`/app/orgs/${orgId}/crm/imports`)
      : Promise.resolve(null),
    canExport
      ? serverGetJson<{ data: ExportSummary[] }>(`/app/orgs/${orgId}/crm/exports`)
      : Promise.resolve(null),
  ]);
  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.crm.data.title} />
      <div className="grid gap-6 xl:grid-cols-2">
        {canImport ? <ImportWizard recent={imports?.data ?? []} /> : null}
        {canExport ? <ExportsPanel initial={exports?.data ?? []} /> : null}
      </div>
    </OrgAccessBoundary>
  );
}
