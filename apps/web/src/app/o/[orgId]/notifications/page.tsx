import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { NotificationList } from '@/components/notifications/notification-list';
import { NotificationPreferencesForm } from '@/components/notifications/notification-preferences';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import { cn } from '@/lib/cn';
import type { NotificationPage, NotificationPreference } from '@/lib/notification-types';
import { getMe, serverGetJson } from '@/lib/server-api';

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ unread?: string }>;
}) {
  const { orgId } = await params;
  const unreadOnly = (await searchParams).unread === '1';
  const m = getMessages('en');
  const base = `/app/orgs/${orgId}/notifications`;
  const [page, preferences, me] = await Promise.all([
    serverGetJson<NotificationPage>(`${base}?limit=20${unreadOnly ? '&unread=true' : ''}`),
    serverGetJson<{ preferences: NotificationPreference[] }>(`${base}/preferences`),
    getMe(),
  ]);
  if (!page || !preferences || !me) notFound();
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';
  const tab = (active: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium',
      active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
    );

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader title={m.notifications.title} />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <nav aria-label={m.notifications.title} className="flex gap-2">
            <Link
              href={`/o/${orgId}/notifications`}
              className={tab(!unreadOnly)}
              aria-current={unreadOnly ? undefined : 'page'}
            >
              {m.notifications.showAll}
            </Link>
            <Link
              href={`/o/${orgId}/notifications?unread=1`}
              className={tab(unreadOnly)}
              aria-current={unreadOnly ? 'page' : undefined}
            >
              {m.notifications.showUnread}
            </Link>
          </nav>
          <NotificationList
            key={unreadOnly ? 'unread' : 'all'}
            initial={page}
            unreadOnly={unreadOnly}
            timezone={timezone}
          />
        </div>
        <div className="lg:col-span-2">
          <NotificationPreferencesForm initial={preferences.preferences} />
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
