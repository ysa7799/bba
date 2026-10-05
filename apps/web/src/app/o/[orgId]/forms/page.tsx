import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { NewFormButton } from '@/components/forms/new-form';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { FormSummary } from '@/lib/forms-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function FormsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('forms.read')) {
    return <CrmForbidden title={m.forms.title} message={m.forms.forbidden} />;
  }
  const status = query.status === 'archived' ? 'archived' : 'active';
  const list = await serverGetJson<{ data: FormSummary[] }>(
    `/app/orgs/${orgId}/forms?status=${status}`,
  );
  if (!list) notFound();
  const canManage = access.permissions.includes('forms.manage');
  const base = `/o/${orgId}/forms`;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.forms.title} actions={canManage ? <NewFormButton /> : null} />
      <nav aria-label={m.forms.title} className="mb-4 flex gap-2 text-sm">
        {(['active', 'archived'] as const).map((tab) => (
          <Link
            key={tab}
            href={tab === 'active' ? base : `${base}?status=archived`}
            aria-current={status === tab ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5',
              status === tab ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {tab === 'active' ? m.forms.active : m.forms.archived}
          </Link>
        ))}
      </nav>
      {list.data.length === 0 ? (
        <EmptyState title={status === 'active' ? m.forms.empty : m.forms.emptyArchived}>
          {status === 'active' ? m.forms.emptyHint : null}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {list.data.map((form) => (
            <li key={form.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <Link
                  href={`${base}/${form.id}`}
                  className="text-sm font-medium text-slate-900 hover:underline"
                >
                  {form.name}
                </Link>
                <p className="text-xs text-slate-500">
                  {form.publishedVersion === null
                    ? m.forms.notPublished
                    : format(m.forms.version, { number: String(form.publishedVersion) })}
                  {form.hasDraft ? ` · ${m.forms.unpublishedChanges}` : ''}
                  {' · '}
                  <span className="font-mono">/f/{form.slug}</span>
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>
                  {format(m.forms.submissionsCount, { count: String(form.submissionCount) })}
                  {form.lastSubmissionAt
                    ? ` · ${format(m.forms.lastSubmission, { when: formatDateTime(form.lastSubmissionAt) })}`
                    : ''}
                </span>
                {access.permissions.includes('forms.submission.read') ? (
                  <Link
                    href={`${base}/${form.id}/submissions`}
                    className="font-medium text-brand-600 hover:underline"
                  >
                    {m.forms.submissions}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </OrgAccessBoundary>
  );
}
