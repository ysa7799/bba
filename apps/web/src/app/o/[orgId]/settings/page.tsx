import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { OrganizationSettingsForm } from '@/components/app/organization-settings-form';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { OrganizationSettings, OrganizationSummary } from '@/lib/api-types';
import { serverGetJson } from '@/lib/server-api';

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const data = await serverGetJson<{
    organization: OrganizationSummary;
    settings: OrganizationSettings;
  }>(`/app/orgs/${orgId}`);
  if (!data) notFound();
  const m = getMessages('en');
  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.app.settings.title} />
      <OrganizationSettingsForm organization={data.organization} settings={data.settings} />
    </OrgAccessBoundary>
  );
}
