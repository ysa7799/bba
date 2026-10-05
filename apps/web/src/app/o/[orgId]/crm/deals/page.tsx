import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { DealBoardView } from '@/components/crm/deal-board';
import { DealFormDialog } from '@/components/crm/deal-form';
import { ExportButton } from '@/components/crm/export-button';
import { FilterSelect, ListFilters } from '@/components/crm/list-filters';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import { crmFormOptions, pickFilters } from '@/lib/crm-server';
import type { DealBoard, PipelineDetail } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function DealsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  if (!access.permissions.includes('crm.deal.read'))
    return <CrmForbidden title={m.crm.deals.title} />;
  const base = `/app/orgs/${orgId}/crm`;
  const pipelines =
    (await serverGetJson<{ data: PipelineDetail[] }>(`${base}/pipelines`))?.data ?? [];
  if (pipelines.length === 0) {
    return (
      <>
        <PageHeader title={m.crm.deals.title} />
        <Alert tone="info">{m.crm.deals.noPipeline}</Alert>
      </>
    );
  }
  const filters = pickFilters(query, ['q', 'ownerUserId', 'pipeline']);
  const pipeline =
    pipelines.find((p) => p.id === filters.pipeline) ??
    pipelines.find((p) => p.isDefault) ??
    pipelines[0];
  if (!pipeline) notFound();
  const boardQuery = new URLSearchParams({
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
  });
  const [board, options] = await Promise.all([
    serverGetJson<DealBoard>(`${base}/pipelines/${pipeline.id}/board?${boardQuery.toString()}`),
    crmFormOptions(orgId, 'deal'),
  ]);
  if (!board) notFound();
  const organization = me.organizations.find((entry) => entry.id === orgId);

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.crm.deals.title}
        actions={
          <div className="flex flex-wrap gap-2">
            <ExportButton
              entityType="deal"
              filters={{
                pipelineId: pipeline.id,
                ...(filters.q ? { q: filters.q } : {}),
                ...(filters.ownerUserId ? { ownerUserId: filters.ownerUserId } : {}),
              }}
            />
            {access.permissions.includes('crm.deal.create') ? (
              <DealFormDialog
                pipelines={pipelines}
                defaultPipelineId={pipeline.id}
                defaultCurrency={organization?.defaultCurrency ?? 'BHD'}
                options={options}
                buttonLabel={m.crm.deals.new}
              />
            ) : null}
          </div>
        }
      />
      <ListFilters q={filters.q ?? ''} clearHref={`/o/${orgId}/crm/deals`}>
        <FilterSelect
          name="pipeline"
          label={m.crm.deals.pipeline}
          value={pipeline.id}
          options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
        />
        <FilterSelect
          name="ownerUserId"
          label={m.crm.owner}
          value={filters.ownerUserId ?? ''}
          options={[
            { value: '', label: m.crm.all },
            { value: 'me', label: m.crm.mine },
            { value: 'none', label: m.crm.unassigned },
            ...options.assignees.map((assignee) => ({
              value: assignee.userId,
              label: assignee.name,
            })),
          ]}
        />
      </ListFilters>
      <DealBoardView board={board} />
    </OrgAccessBoundary>
  );
}
