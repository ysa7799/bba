import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { CustomFieldValues } from '@/components/crm/custom-field-inputs';
import { DealFormDialog } from '@/components/crm/deal-form';
import { DeleteRecordButton } from '@/components/crm/delete-record-button';
import { DetailList, Section } from '@/components/crm/detail';
import { NotesPanel } from '@/components/crm/notes-panel';
import { TagList } from '@/components/crm/tag-badge';
import { TimelinePanel } from '@/components/crm/timeline-panel';
import { NewTaskButton, TaskList } from '@/components/crm/task-list';
import { PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { crmFormOptions } from '@/lib/crm-server';
import type {
  ActivitySummary,
  DealSummary,
  NoteSummary,
  PipelineDetail,
  TaskSummary,
} from '@/lib/crm-types';
import { formatDate, formatMoney } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function DealPage({
  params,
}: {
  params: Promise<{ orgId: string; dealId: string }>;
}) {
  const { orgId, dealId } = await params;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('crm.deal.read')) return <CrmForbidden title={m.crm.deals.title} />;
  const base = `/app/orgs/${orgId}/crm`;
  const [deal, notes, tasks, pipelines, options, timeline] = await Promise.all([
    serverGetJson<{ deal: DealSummary }>(`${base}/deals/${dealId}`),
    serverGetJson<Page<NoteSummary>>(`${base}/deals/${dealId}/notes?limit=50`),
    can('crm.task.read')
      ? serverGetJson<Page<TaskSummary>>(`${base}/tasks?dealId=${dealId}&limit=50`)
      : Promise.resolve(null),
    serverGetJson<{ data: PipelineDetail[] }>(`${base}/pipelines`),
    crmFormOptions(orgId, 'deal'),
    serverGetJson<{ data: ActivitySummary[]; nextCursor: string | null }>(
      `${base}/deals/${dealId}/timeline?limit=25`,
    ),
  ]);
  if (!deal) notFound();
  const d = deal.deal;
  const organization = me.organizations.find((entry) => entry.id === orgId);
  const statusLabel =
    d.status === 'won'
      ? m.crm.deals.won
      : d.status === 'lost'
        ? m.crm.deals.lost
        : m.crm.deals.open;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <nav className="mb-2 text-sm">
        <Link
          href={`/o/${orgId}/crm/deals?pipeline=${d.pipelineId}`}
          className="text-slate-500 hover:underline"
        >
          ← {m.crm.deals.title}
        </Link>
      </nav>
      <PageHeader
        title={d.name}
        actions={
          <div className="flex gap-2">
            {can('crm.deal.update') ? (
              <DealFormDialog
                deal={d}
                pipelines={pipelines?.data ?? []}
                defaultCurrency={organization?.defaultCurrency ?? 'BHD'}
                options={options}
                buttonLabel={m.crm.edit}
                buttonVariant="secondary"
              />
            ) : null}
            {can('crm.deal.delete') ? (
              <DeleteRecordButton
                path={`${base}/deals/${d.id}`}
                title={m.crm.delete}
                message={format(m.crm.deals.deleteConfirm, { name: d.name })}
                redirectTo={`/o/${orgId}/crm/deals`}
              />
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section title={m.crm.details}>
            <DetailList
              items={[
                [m.crm.deals.value, d.value ? formatMoney(d.value) : null],
                [m.crm.deals.pipeline, d.pipelineName],
                [m.crm.deals.stage, `${d.stageName} (${statusLabel})`],
                [m.crm.deals.probability, `${d.probability}%`],
                [
                  m.crm.deals.expectedClose,
                  d.expectedCloseDate ? formatDate(d.expectedCloseDate) : null,
                ],
                [
                  m.crm.deals.contact,
                  d.contact ? (
                    <Link
                      href={`/o/${orgId}/crm/contacts/${d.contact.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {d.contact.name}
                    </Link>
                  ) : null,
                ],
                [
                  m.crm.deals.company,
                  d.company ? (
                    <Link
                      href={`/o/${orgId}/crm/companies/${d.company.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {d.company.name}
                    </Link>
                  ) : null,
                ],
                [m.crm.owner, d.ownerName],
                ...(d.closedAt
                  ? ([[m.crm.deals.closedAt, formatDate(d.closedAt)]] as [string, string][])
                  : []),
                ...(d.lostReason
                  ? ([[m.crm.deals.lostReason, d.lostReason]] as [string, string][])
                  : []),
                [m.crm.tags, d.tags.length > 0 ? <TagList tags={d.tags} /> : null],
                [m.crm.created, formatDate(d.createdAt)],
              ]}
            />
          </Section>
          {options.fields.length > 0 ? (
            <Section title={m.crm.customFields}>
              <CustomFieldValues
                fields={options.fields}
                values={d.customFields}
                assignees={options.assignees}
              />
            </Section>
          ) : null}
          <TimelinePanel
            record={{ kind: 'deals', id: d.id }}
            initial={timeline ?? { data: [], nextCursor: null }}
            timezone={organization?.timezone ?? 'Asia/Bahrain'}
            currentUserId={me.user.id}
          />
        </div>
        <div className="space-y-6 lg:col-span-2">
          <NotesPanel
            parentPath={`deals/${d.id}`}
            notes={notes?.data ?? []}
            currentUserId={me.user.id}
          />
          {tasks ? (
            <Section
              title={m.crm.tasks.title}
              actions={<NewTaskButton assignees={options.assignees} link={{ dealId: d.id }} />}
            >
              <TaskList tasks={tasks.data} timezone={organization?.timezone ?? 'Asia/Bahrain'} />
            </Section>
          ) : null}
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
