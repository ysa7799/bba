import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavLink } from '@/components/app/nav-link';
import { OrgSwitcher } from '@/components/app/org-switcher';
import { SignOutButton } from '@/components/app/sign-out-button';
import { getMessages } from '@/i18n';
import { getMe } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/**
 * Tenant app shell. Access is enforced by the API on every request; this layout only decides
 * what to render (it never grants access by itself).
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const me = await getMe();
  if (!me) redirect(`/login?next=${encodeURIComponent(`/o/${orgId}`)}`);
  const organization = me.organizations.find((entry) => entry.id === orgId);
  if (!organization) notFound();
  const m = getMessages(me.user.locale);
  const base = `/o/${orgId}`;

  return (
    <div className="min-h-screen md:flex">
      <aside className="bg-slate-900 md:fixed md:inset-y-0 md:w-60">
        <div className="flex h-full flex-col gap-4 p-4">
          <div className="text-sm font-semibold tracking-tight text-white">{m.common.appName}</div>
          <OrgSwitcher organizations={me.organizations} currentId={orgId} />
          <nav aria-label="Main" className="flex gap-1 overflow-x-auto md:flex-col">
            <NavLink href={base} label={m.app.nav.overview} exact />
            <p className="hidden px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:block">
              {m.app.nav.crmSection}
            </p>
            <NavLink href={`${base}/crm/contacts`} label={m.app.nav.contacts} />
            <NavLink href={`${base}/crm/companies`} label={m.app.nav.companies} />
            <NavLink href={`${base}/crm/deals`} label={m.app.nav.deals} />
            <NavLink href={`${base}/crm/tasks`} label={m.app.nav.tasks} />
            <NavLink href={`${base}/crm/data`} label={m.app.nav.importExport} />
            <NavLink href={`${base}/crm/settings`} label={m.app.nav.crmSettings} />
            <p className="hidden px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:block">
              {m.app.nav.adminSection}
            </p>
            <NavLink href={`${base}/members`} label={m.app.nav.members} />
            <NavLink href={`${base}/roles`} label={m.app.nav.roles} />
            <NavLink href={`${base}/settings`} label={m.app.nav.settings} />
            <NavLink href={`${base}/billing`} label={m.app.nav.billing} />
            <NavLink href={`${base}/audit`} label={m.app.nav.audit} />
          </nav>
        </div>
      </aside>
      <div className="md:ps-60">
        <header className="flex h-14 items-center justify-end gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
          <span className="truncate text-sm text-slate-700">{me.user.name}</span>
          <SignOutButton />
        </header>
        <main className="px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
