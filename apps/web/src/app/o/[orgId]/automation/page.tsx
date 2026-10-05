import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { NewWorkflowButton } from '@/components/automation/workflow-actions';
import { StatusBadge } from '@/components/automation/workflow-tabs';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { WorkflowSummary } from '@/lib/automation-types';
import { formatDateTime } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function WorkflowsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const m = getMessages('en');
  const a = m.automation;
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('automation.workflow.read')) {
    return <CrmForbidden title={a.title} message={a.forbidden} />;
  }
  const list = await serverGetJson<{ data: WorkflowSummary[] }>(
    `/app/orgs/${orgId}/automation/workflows`,
  );
  if (!list) notFound();
  const canManage = access.permissions.includes('automation.workflow.manage');

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={a.title} actions={canManage ? <NewWorkflowButton /> : null} />
      {list.data.length === 0 ? (
        <EmptyState title={a.empty}>{a.emptyHint}</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {list.data.map((workflow) => (
            <li key={workflow.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/o/${orgId}/automation/${workflow.id}`}
                    className="text-sm font-medium text-slate-900 hover:underline"
                  >
                    {workflow.name}
                  </Link>
                  <StatusBadge status={workflow.status} label={a.status[workflow.status]} />
                </div>
                <p className="text-xs text-slate-500">
                  {a.triggers[workflow.triggerType]}
                  {workflow.hasDraft && workflow.publishedVersion !== null
                    ? ` · ${a.unpublishedChanges}`
                    : ''}
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>
                  {workflow.runs.total === 0
                    ? a.neverRun
                    : `${format(a.runsSummary, {
                        total: String(workflow.runs.total),
                        failed: String(workflow.runs.failed),
                      })}${
                        workflow.runs.lastStartedAt
                          ? ` · ${formatDateTime(workflow.runs.lastStartedAt)}`
                          : ''
                      }`}
                </span>
                <Link
                  href={`/o/${orgId}/automation/${workflow.id}/runs`}
                  className="font-medium text-brand-600 hover:underline"
                >
                  {a.runs}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </OrgAccessBoundary>
  );
}
