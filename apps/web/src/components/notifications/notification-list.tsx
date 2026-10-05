'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/card';
import { ApiError, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { NotificationPage, NotificationSummary } from '@/lib/notification-types';
import { NOTIFICATIONS_CHANGED } from './notification-bell';

function announceChange() {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}

/** The member's notifications, newest first, with "show more" paging and read state. */
export function NotificationList({
  initial,
  unreadOnly,
  timezone,
}: {
  initial: NotificationPage;
  unreadOnly: boolean;
  /** The organization's timezone. */
  timezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const base = `/app/orgs/${organizationId}/notifications`;
  const [items, setItems] = useState<NotificationSummary[]>(initial.data);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [unread, setUnread] = useState(initial.unread);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function attempt(key: string, action: () => Promise<void>) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setPending(null);
    }
  }

  function loadMore() {
    if (!cursor) return;
    void attempt('more', async () => {
      const query = new URLSearchParams({ limit: '20', cursor });
      if (unreadOnly) query.set('unread', 'true');
      const next = await apiRequest<NotificationPage>(`${base}?${query.toString()}`);
      setItems((current) => [
        ...current,
        ...next.data.filter((entry) => !current.some((seen) => seen.id === entry.id)),
      ]);
      setCursor(next.nextCursor);
      setUnread(next.unread);
    });
  }

  function markRead(id: string) {
    void attempt(id, async () => {
      const { notification } = await apiRequest<{ notification: NotificationSummary }>(
        `${base}/${id}/read`,
        { method: 'POST' },
      );
      setItems((current) => current.map((entry) => (entry.id === id ? notification : entry)));
      setUnread((count) => Math.max(0, count - 1));
      announceChange();
    });
  }

  function markAllRead() {
    void attempt('all', async () => {
      await apiRequest(`${base}/read-all`, { method: 'POST' });
      const now = new Date().toISOString();
      setItems((current) => current.map((entry) => ({ ...entry, readAt: entry.readAt ?? now })));
      setUnread(0);
      announceChange();
    });
  }

  /** Links are server-built and constrained to this organization; anything else is not linked. */
  const ownLink = (link: string | null) =>
    link?.startsWith(`/o/${organizationId}/`) === true ? link : null;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm text-slate-600" data-testid="notifications-unread">
          {m.notifications.unread}: <span className="font-semibold text-slate-900">{unread}</span>
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={pending === 'all'}
          disabled={unread === 0}
          onClick={markAllRead}
        >
          {m.notifications.markAllRead}
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items.length === 0 ? (
        <EmptyState title={unreadOnly ? m.notifications.emptyUnread : m.notifications.empty} />
      ) : (
        <ul className="divide-y divide-slate-100" aria-label={m.notifications.title}>
          {items.map((item) => {
            const link = ownLink(item.link);
            const isUnread = item.readAt === null;
            return (
              <li
                key={item.id}
                className={cn('flex items-start gap-3 py-3', isUnread ? '' : 'opacity-75')}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    isUnread ? 'bg-brand-600' : 'bg-transparent',
                  )}
                />
                <div className="min-w-0 flex-1">
                  {link ? (
                    <Link
                      href={link}
                      className="block break-words text-sm font-medium text-slate-900 hover:underline"
                      onClick={() => {
                        if (isUnread) markRead(item.id);
                      }}
                    >
                      {item.title}
                    </Link>
                  ) : (
                    <p className="break-words text-sm font-medium text-slate-900">{item.title}</p>
                  )}
                  {item.body ? (
                    <p className="mt-0.5 break-words text-sm text-slate-600">{item.body}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatDateTime(item.createdAt, timezone)}
                    {isUnread ? <span className="sr-only"> · {m.notifications.unread}</span> : null}
                  </p>
                </div>
                {isUnread ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending === item.id}
                    onClick={() => markRead(item.id)}
                  >
                    {m.notifications.markRead}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {cursor ? (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="ghost" loading={pending === 'more'} onClick={loadMore}>
            {m.notifications.loadMore}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
