import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { MemberSummary, Page } from '@/lib/api-types';
import { pickString } from '@/lib/navigation';
import { serverApiAsUser } from '@/lib/server-api';

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

  const response = await serverApiAsUser(`/app/orgs/${orgId}/members?${qs.toString()}`);
  if (response.status === 404 || response.status === 401) notFound();
  if (!response.ok) throw new Error(`Failed to load members (${response.status})`);
  const page = (await response.json()) as Page<MemberSummary>;
  const m = getMessages('en');
  const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

  const nextHref = page.nextCursor
    ? `?${new URLSearchParams({ ...(search ? { search } : {}), cursor: page.nextCursor }).toString()}`
    : null;

  return (
    <>
      <PageHeader title={m.app.members.title} />
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
            <thead className="bg-slate-50 text-start text-xs font-medium uppercase text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.name}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.email}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.status}
                </th>
                <th scope="col" className="px-4 py-2 text-start">
                  {m.app.members.joined}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page.data.map((member) => (
                <tr key={member.membershipId}>
                  <td className="px-4 py-2 font-medium text-slate-900">{member.name}</td>
                  <td className="px-4 py-2 text-slate-600">{member.email}</td>
                  <td className="px-4 py-2 capitalize text-slate-600">{member.status}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {dateFormat.format(new Date(member.joinedAt))}
                  </td>
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
