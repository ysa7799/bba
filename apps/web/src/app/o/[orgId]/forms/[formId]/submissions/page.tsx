import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { Section } from '@/components/crm/detail';
import { FormTabs } from '@/components/forms/form-tabs';
import { ReleaseButton } from '@/components/forms/release-button';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { FormDetail, SubmissionDetail, SubmissionSummary } from '@/lib/forms-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function SubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; formId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, formId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access || !UUID.test(formId)) notFound();
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('forms.submission.read')) {
    return <CrmForbidden title={m.forms.submissions} message={m.forms.forbidden} />;
  }
  const status = query.status === 'spam' ? 'spam' : 'accepted';
  const cursor = typeof query.cursor === 'string' ? query.cursor : null;
  const selectedId =
    typeof query.submission === 'string' && UUID.test(query.submission) ? query.submission : null;
  const api = `/app/orgs/${orgId}/forms/${formId}`;
  const qs = new URLSearchParams({ status, limit: '25', ...(cursor ? { cursor } : {}) });
  const [detail, list, selected] = await Promise.all([
    serverGetJson<{ form: FormDetail }>(api),
    serverGetJson<{ data: SubmissionSummary[]; nextCursor: string | null }>(
      `${api}/submissions?${qs.toString()}`,
    ),
    selectedId
      ? serverGetJson<{ submission: SubmissionDetail }>(`${api}/submissions/${selectedId}`)
      : Promise.resolve(null),
  ]);
  if (!detail || !list) notFound();
  const page = `/o/${orgId}/forms/${formId}/submissions`;
  const link = (params: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = { status: status === 'spam' ? 'spam' : null, cursor, ...params };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `${page}?${text}` : page;
  };
  const submission = selected?.submission ?? null;
  const reasons = m.forms.spamReason as Record<string, string>;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <Link href={`/o/${orgId}/forms`} className="text-sm text-slate-600 hover:underline">
        {m.forms.backToForms}
      </Link>
      <PageHeader title={detail.form.name} />
      <FormTabs orgId={orgId} formId={formId} current="submissions" showSubmissions />
      <nav aria-label={m.forms.submissions} className="mb-4 flex gap-2 text-sm">
        {(['accepted', 'spam'] as const).map((tab) => (
          <Link
            key={tab}
            href={tab === 'spam' ? `${page}?status=spam` : page}
            aria-current={status === tab ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5',
              status === tab ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {tab === 'spam' ? m.forms.spam : m.forms.accepted}
          </Link>
        ))}
      </nav>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-3">
          {list.data.length === 0 ? (
            <EmptyState title={status === 'spam' ? m.forms.noSpam : m.forms.noSubmissions} />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
              {list.data.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={link({ submission: entry.id })}
                    aria-current={entry.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'block p-3 hover:bg-slate-50',
                      entry.id === selectedId && 'bg-slate-50',
                    )}
                  >
                    <div className="flex justify-between gap-3 text-xs text-slate-500">
                      <span>{formatDateTime(entry.submittedAt)}</span>
                      <span>
                        {entry.contact?.name ?? m.forms.noContact} ·{' '}
                        {format(m.forms.versionShort, { number: String(entry.versionNumber) })}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-900">
                      {entry.preview.map((item) => item.value).join(' · ')}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between text-sm">
            {cursor ? (
              <Link href={link({ cursor: null, submission: null })} className="text-brand-600">
                {m.forms.newest}
              </Link>
            ) : (
              <span />
            )}
            {list.nextCursor ? (
              <Link
                href={link({ cursor: list.nextCursor, submission: null })}
                className="text-brand-600"
              >
                {m.forms.older}
              </Link>
            ) : null}
          </div>
        </div>
        <Section title={m.forms.answers}>
          {submission ? (
            <div className="space-y-4 text-sm">
              <dl className="space-y-2">
                {submission.answers.map((answer) => (
                  <div key={answer.key}>
                    <dt className="text-xs font-medium text-slate-500">{answer.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-slate-900">
                      {answer.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-slate-500">
                {m.forms.submittedAt}: {formatDateTime(submission.submittedAt)}
              </p>
              {submission.contact ? (
                <p>
                  {m.forms.contact}:{' '}
                  <Link
                    href={`/o/${orgId}/crm/contacts/${submission.contact.id}`}
                    className="text-brand-600 hover:underline"
                  >
                    {submission.contact.name}
                  </Link>
                  {submission.dealId ? (
                    <>
                      {' · '}
                      <Link
                        href={`/o/${orgId}/crm/deals/${submission.dealId}`}
                        className="text-brand-600 hover:underline"
                      >
                        {m.forms.viewDeal}
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}
              {submission.spamReasons.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-slate-500">{m.forms.spamReasons}</p>
                  <ul className="list-inside list-disc text-slate-700">
                    {submission.spamReasons.map((reason) => (
                      <li key={reason}>{reasons[reason] ?? reason}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {submission.processingNotes.length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-slate-500">{m.forms.processingNotes}</p>
                  <ul className="list-inside list-disc text-slate-700">
                    {submission.processingNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {submission.status === 'spam' && can('forms.manage') ? (
                <ReleaseButton formId={formId} submissionId={submission.id} />
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{m.forms.selectSubmission}</p>
          )}
        </Section>
      </div>
    </OrgAccessBoundary>
  );
}
