import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { AuditLogEntry, Page } from '@/lib/api-types';
import { pickString } from '@/lib/navigation';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

// Mirrors the API's action catalogue for the filter control.
const ACTIONS = [
  'auth.login',
  'organization.created',
  'organization.updated',
  'organization.settings_updated',
  'member.invited',
  'member.invitation_revoked',
  'member.joined',
  'member.roles_changed',
  'member.suspended',
  'member.reactivated',
  'member.removed',
  'member.left',
  'role.created',
  'role.updated',
  'role.deleted',
  'billing.profile_updated',
  'billing.checkout_started',
  'billing.subscription_activated',
  'crm.contact.deleted',
  'crm.company.deleted',
  'crm.deal.deleted',
  'crm.bulk_action',
  'crm.pipeline.created',
  'crm.pipeline.updated',
  'crm.pipeline.deleted',
  'crm.custom_field.created',
  'crm.custom_field.updated',
  'crm.custom_field.archived',
  'crm.tag.deleted',
  'crm.import.started',
  'crm.import.completed',
  'crm.export.requested',
  'crm.export.downloaded',
];

export default async function AuditPage({
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
  if (!access.permissions.includes('audit.read')) {
    return (
      <>
        <PageHeader title={m.app.audit.title} />
        <Alert tone="info">{m.app.audit.forbidden}</Alert>
      </>
    );
  }

  const action = pickString(query.action);
  const cursor = pickString(query.cursor);
  const qs = new URLSearchParams({ limit: '50' });
  if (action && ACTIONS.includes(action)) qs.set('action', action);
  if (cursor) qs.set('cursor', cursor);
  const page = await serverGetJson<Page<AuditLogEntry>>(
    `/app/orgs/${orgId}/audit-logs?${qs.toString()}`,
  );
  if (!page) notFound();

  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const nextHref = page.nextCursor
    ? `?${new URLSearchParams({ ...(action ? { action } : {}), cursor: page.nextCursor }).toString()}`
    : null;

  return (
    <>
      <PageHeader title={m.app.audit.title} />
      <form className="mb-4 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="sr-only">{m.app.audit.action}</span>
          <select
            name="action"
            defaultValue={action ?? ''}
            className="rounded-md border-0 py-2 ps-3 pe-8 text-sm ring-1 ring-inset ring-slate-300"
          >
            <option value="">{m.app.audit.allActions}</option>
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-9 rounded-md bg-white px-3 text-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
        >
          {m.app.audit.filter}
        </button>
      </form>
      {page.data.length === 0 ? (
        <EmptyState title={m.app.audit.empty} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.audit.when}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.audit.actor}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.audit.action}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.audit.target}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.data.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {dateFormat.format(new Date(entry.createdAt))}
                  </td>
                  <td className="px-4 py-2 text-slate-900">
                    {entry.actorLabel ?? entry.actorType}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{entry.action}</td>
                  <td className="px-4 py-2 text-slate-600">{entry.targetType ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {nextHref ? (
        <div className="mt-4">
          <Link href={nextHref} className="text-sm font-medium text-brand-600 hover:underline">
            {m.common.next} →
          </Link>
        </div>
      ) : null}
    </>
  );
}
