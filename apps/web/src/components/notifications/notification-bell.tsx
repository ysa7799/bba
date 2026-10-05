'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';

/** Fired by the notifications page after marking items read, so the badge updates at once. */
export const NOTIFICATIONS_CHANGED = 'businessos:notifications-changed';

const POLL_MS = 60_000;

/**
 * Header bell with the member's unread count. The count is a convenience indicator: it is
 * refreshed on navigation, on focus and every minute while the tab is visible, and simply hides
 * when it cannot be loaded (the notifications page shows errors properly).
 */
export function NotificationBell({ orgId }: { orgId: string }) {
  const m = useMessages();
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void apiRequest<{ unread: number }>(`/app/orgs/${orgId}/notifications/unread-count`)
        .then((result) => result.unread)
        .catch(() => null)
        .then((value) => {
          if (!cancelled) setUnread(value);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    const timer = window.setInterval(onVisible, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
    // Navigating re-subscribes, which also re-reads the count.
  }, [orgId, pathname]);

  const count = unread ?? 0;
  const label =
    count > 0 ? format(m.notifications.bellUnread, { count: String(count) }) : m.notifications.bell;

  return (
    <Link
      href={`/o/${orgId}/notifications`}
      aria-label={label}
      title={label}
      data-testid="notification-bell"
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -end-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-[11px] font-semibold leading-5 text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
