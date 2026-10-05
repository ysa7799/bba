import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { FilterSelect, ListFilters, NextPageLink } from '@/components/crm/list-filters';
import { NewTaskButton, TaskList } from '@/components/crm/task-list';
import { Card, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { pickFilters } from '@/lib/crm-server';
import type { Assignee, TaskSummary } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function TasksPage({
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
  if (!access.permissions.includes('crm.task.read'))
    return <CrmForbidden title={m.crm.tasks.title} />;
  // Default view: my open tasks.
  const filters: Record<string, string> & { status: string; assigneeUserId: string } = {
    status: 'open',
    assigneeUserId: 'me',
    ...pickFilters(query, ['q', 'status', 'assigneeUserId', 'due', 'sort']),
  };
  const apiFilters = Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== 'all'),
  );
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const qs = new URLSearchParams({ ...apiFilters, limit: '50', ...(cursor ? { cursor } : {}) });
  const [page, assignees] = await Promise.all([
    serverGetJson<Page<TaskSummary>>(`/app/orgs/${orgId}/crm/tasks?${qs.toString()}`),
    serverGetJson<{ data: Assignee[] }>(`/app/orgs/${orgId}/crm/assignees`),
  ]);
  if (!page) notFound();
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';
  const nextHref = page.nextCursor
    ? `?${new URLSearchParams({ ...filters, cursor: page.nextCursor }).toString()}`
    : null;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.crm.tasks.title}
        actions={<NewTaskButton assignees={assignees?.data ?? []} />}
      />
      <ListFilters q={filters.q ?? ''} clearHref={`/o/${orgId}/crm/tasks`}>
        <FilterSelect
          name="status"
          label={m.crm.contacts.status}
          value={filters.status}
          options={[
            { value: 'open', label: m.crm.tasks.openTasks },
            { value: 'completed', label: m.crm.tasks.completed },
            { value: 'all', label: m.crm.all },
          ]}
        />
        <FilterSelect
          name="assigneeUserId"
          label={m.crm.tasks.assignee}
          value={filters.assigneeUserId}
          options={[
            { value: 'me', label: m.crm.mine },
            { value: 'all', label: m.crm.all },
            { value: 'none', label: m.crm.unassigned },
            ...(assignees?.data ?? []).map((assignee) => ({
              value: assignee.userId,
              label: assignee.name,
            })),
          ]}
        />
        <FilterSelect
          name="due"
          label={m.crm.tasks.due}
          value={filters.due ?? ''}
          options={[
            { value: '', label: m.crm.all },
            { value: 'overdue', label: m.crm.tasks.overdue },
            { value: 'today', label: m.crm.tasks.today },
            { value: 'upcoming', label: m.crm.tasks.upcoming },
            { value: 'none', label: m.crm.tasks.noDue },
          ]}
        />
      </ListFilters>
      <Card className="px-4 py-2">
        <TaskList tasks={page.data} timezone={timezone} />
      </Card>
      <NextPageLink href={nextHref} />
    </OrgAccessBoundary>
  );
}
