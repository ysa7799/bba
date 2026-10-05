import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { CustomFieldSettings } from '@/components/crm/custom-field-settings';
import { PipelineSettings } from '@/components/crm/pipeline-settings';
import { TagSettings } from '@/components/crm/tag-settings';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { CustomFieldDefinition, PipelineDetail, TagSummary } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function CrmSettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  const can = (permission: string) => access.permissions.includes(permission);
  const anyRead = ['crm.contact.read', 'crm.company.read', 'crm.deal.read', 'crm.task.read'].some(
    can,
  );
  if (!anyRead) return <CrmForbidden title={m.crm.settings.title} />;
  const base = `/app/orgs/${orgId}/crm`;
  const [pipelines, fields, tags] = await Promise.all([
    can('crm.deal.read')
      ? serverGetJson<{ data: PipelineDetail[] }>(`${base}/pipelines`)
      : Promise.resolve(null),
    serverGetJson<{ data: CustomFieldDefinition[] }>(
      `${base}/custom-fields${can('crm.custom_field.manage') ? '?includeArchived=true' : ''}`,
    ),
    serverGetJson<{ data: TagSummary[] }>(`${base}/tags`),
  ]);
  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.crm.settings.title} />
      <div className="grid gap-6 xl:grid-cols-2">
        {pipelines ? <PipelineSettings pipelines={pipelines.data} /> : null}
        <div className="space-y-6">
          <CustomFieldSettings fields={fields?.data ?? []} />
          <TagSettings tags={tags?.data ?? []} />
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
