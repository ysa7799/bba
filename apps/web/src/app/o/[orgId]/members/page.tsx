import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InviteMemberDialog } from '@/components/app/invite-member-dialog';
import { MemberActions } from '@/components/app/member-actions';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { PendingInvitations } from '@/components/app/pending-invitations';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { MemberSummary, Page, PendingInvitation, RoleSummary } from '@/lib/api-types';
import { pickString } from '@/lib/navigation';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const search = pickString(query.search)?.trim().slice(0, 100) ?? '';
  const cursor = pickString(query.cursor);
  const qs = new URLSearchParams({ limit: '25' });
  if (search) qs.set('search', search);
  if (cursor) qs.set('cursor', cursor);

  const [page, access, roles] = await Promise.all([
    serverGetJson<Page<MemberSummary>>(`/app/orgs/${orgId}/members?${qs.toString()}`),
    getOrgAccess(orgId),
    serverGetJson<{ data: RoleSummary[] }>(`/app/orgs/${orgId}/roles`),
  ]);
  if (!page || !access || !roles) notFound();
  const canManage = access.permissions.includes('settings.users.manage');
  const invitations = canManage
    ? ((await serverGetJson<{ data: PendingInvitation[] }>(`/app/orgs/${orgId}/invitations`))
        ?.data ?? [])
    : [];

  const m = getMessages('en');
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
  const nextHref = page.nextCursor
    ? `?${new URLSearchParams({ ...(search ? { search } : {}), cursor: page.nextCursor }).toString()}`
    : null;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.app.members.title}
        actions={canManage ? <InviteMemberDialog roles={roles.data} /> : null}
      />
      <form className="mb-4 max-w-sm" role="search">
        <label htmlFor="member-search" className="sr-only">
          {m.app.members.search}
        </label>
        <input
          id="member-search"
          name="search"
          defaultValue={search}
          placeholder={m.app.members.search}
          className="block w-full rounded-md border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-600"
        />
      </form>
      {page.data.length === 0 ? (
        <EmptyState title={m.app.members.empty} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-medium uppercase text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.name}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.email}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.roles}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.status}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.joined}
                </th>
                {canManage ? (
                  <th scope="col" className="px-4 py-2 text-start">
                    {m.app.members.actions}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.data.map((member) => (
                <tr key={member.membershipId}>
                  <td className="px-4 py-2 font-medium text-slate-900">
                    {member.name}
                    {member.membershipId === access.membershipId ? (
                      <span className="ms-1 text-xs font-normal text-slate-500">
                        ({m.app.members.you})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{member.email}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {member.roles.map((role) => role.name).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2 capitalize text-slate-600">{member.status}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {dateFormat.format(new Date(member.joinedAt))}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-2">
                      <MemberActions member={member} roles={roles.data} />
                    </td>
                  ) : null}
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
      {canManage ? <PendingInvitations invitations={invitations} /> : null}
    </OrgAccessBoundary>
  );
}
