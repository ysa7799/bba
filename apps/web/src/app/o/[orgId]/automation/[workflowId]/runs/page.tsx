import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { RunActions } from '@/components/automation/run-actions';
import { StatusBadge, WorkflowTabs } from '@/components/automation/workflow-tabs';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import type { RunDetail, RunStatus, RunSummary, WorkflowDetail } from '@/lib/automation-types';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES: RunStatus[] = ['running', 'waiting', 'completed', 'failed', 'cancelled', 'skipped'];

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; workflowId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, workflowId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const a = m.automation;
  const access = await getOrgAccess(orgId);
  if (!access || !UUID.test(workflowId)) notFound();
  if (!access.permissions.includes('automation.workflow.read')) {
    return <CrmForbidden title={a.runs} message={a.forbidden} />;
  }
  const status = STATUSES.find((entry) => entry === query.status) ?? null;
  const cursor = typeof query.cursor === 'string' ? query.cursor : null;
  const selectedId = typeof query.run === 'string' && UUID.test(query.run) ? query.run : null;
  const api = `/app/orgs/${orgId}/automation`;
  const qs = new URLSearchParams({
    limit: '25',
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [detail, list, selected] = await Promise.all([
    serverGetJson<{ workflow: WorkflowDetail }>(`${api}/workflows/${workflowId}`),
    serverGetJson<{ data: RunSummary[]; nextCursor: string | null }>(
      `${api}/workflows/${workflowId}/runs?${qs.toString()}`,
    ),
    selectedId
      ? serverGetJson<{ run: RunDetail }>(`${api}/runs/${selectedId}`)
      : Promise.resolve(null),
  ]);
  if (!detail || !list) notFound();
  const page = `/o/${orgId}/automation/${workflowId}/runs`;
  const link = (params: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ status, cursor, ...params })) {
      if (value) next.set(key, value);
    }
    const text = next.toString();
    return text ? `${page}?${text}` : page;
  };
  const run = selected?.run ?? null;
  const stepTitle = (step: RunDetail['steps'][number]) => {
    const node = (detail.workflow.published ?? detail.workflow.draft)?.definition.nodes.find(
      (entry) => entry.key === step.nodeKey,
    );
    if (node?.label) return node.label;
    if (step.action && step.action in a.actions) {
      return a.actions[step.action as keyof typeof a.actions];
    }
    return a.stepKinds[step.nodeType];
  };

  return (
    <OrgAccessBoundary orgId={orgId}>
      <Link href={`/o/${orgId}/automation`} className="text-sm text-slate-600 hover:underline">
        {a.backToWorkflows}
      </Link>
      <PageHeader title={detail.workflow.name} />
      <WorkflowTabs orgId={orgId} workflowId={workflowId} current="runs" />
      <nav aria-label={a.runs} className="mb-4 flex flex-wrap gap-2 text-sm">
        {[null, ...STATUSES].map((entry) => (
          <Link
            key={entry ?? 'all'}
            href={entry ? `${page}?status=${entry}` : page}
            aria-current={status === entry ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5',
              status === entry ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {entry ? a.runStatus[entry] : a.allRuns}
          </Link>
        ))}
      </nav>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          {list.data.length === 0 ? (
            <EmptyState title={a.noRuns} />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {list.data.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={link({ run: entry.id })}
                    aria-current={entry.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'block p-3 hover:bg-slate-50',
                      entry.id === selectedId && 'bg-slate-50',
                    )}
                    data-testid="run-row"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm text-slate-900">
                        {entry.contact?.name ??
                          a.triggers[entry.triggerType as keyof typeof a.triggers]}
                      </span>
                      <StatusBadge status={entry.status} label={a.runStatus[entry.status]} />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDateTime(entry.startedAt)}
                      {entry.status === 'waiting' && entry.resumeAt
                        ? ` · ${format(a.resumesAt, { when: formatDateTime(entry.resumeAt) })}`
                        : ''}
                    </p>
                    {entry.error ? (
                      <p className="mt-1 truncate text-xs text-red-700">{entry.error}</p>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between text-sm">
            {cursor ? (
              <Link href={link({ cursor: null, run: null })} className="text-brand-600">
                {a.newest}
              </Link>
            ) : (
              <span />
            )}
            {list.nextCursor ? (
              <Link href={link({ cursor: list.nextCursor, run: null })} className="text-brand-600">
                {a.older}
              </Link>
            ) : null}
          </div>
        </div>
        <Section title={a.stepsTaken}>
          {run ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <StatusBadge status={run.status} label={a.runStatus[run.status]} />
                  <span className="text-xs text-slate-500">
                    {a.startedAt}: {formatDateTime(run.startedAt)}
                  </span>
                </div>
                <RunActions runId={run.id} status={run.status} />
              </div>
              {run.contact ? (
                <p>
                  {a.contact}:{' '}
                  <Link
                    href={`/o/${orgId}/crm/contacts/${run.contact.id}`}
                    className="text-brand-600 hover:underline"
                  >
                    {run.contact.name}
                  </Link>
                </p>
              ) : null}
              {run.error ? <p className="text-red-700">{run.error}</p> : null}
              <ol className="space-y-2" data-testid="run-steps">
                {run.steps.map((step) => (
                  <li key={step.nodeKey} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{stepTitle(step)}</span>
                      <StatusBadge
                        status={step.status === 'succeeded' ? 'completed' : step.status}
                        label={step.status}
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {format(a.attempts, { count: String(step.attempts) })}
                      {step.resumeAt && step.status === 'waiting'
                        ? ` · ${format(a.resumesAt, { when: formatDateTime(step.resumeAt) })}`
                        : ''}
                    </p>
                    {step.error ? <p className="mt-1 text-xs text-red-700">{step.error}</p> : null}
                  </li>
                ))}
              </ol>
              <div>
                <p className="mb-1 text-xs font-medium text-slate-500">{a.log}</p>
                <ul className="space-y-1 text-xs">
                  {run.logs.map((entry, index) => (
                    <li
                      key={index}
                      className={cn(
                        entry.level === 'error'
                          ? 'text-red-700'
                          : entry.level === 'warn'
                            ? 'text-amber-700'
                            : 'text-slate-600',
                      )}
                    >
                      {formatDateTime(entry.at)} · {entry.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{a.selectRun}</p>
          )}
        </Section>
      </div>
    </OrgAccessBoundary>
  );
}
