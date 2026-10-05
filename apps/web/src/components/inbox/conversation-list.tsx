import Link from 'next/link';
import { TagBadge } from '@/components/crm/tag-badge';
import { EmptyState } from '@/components/ui/card';
import { format, getMessages } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { ConversationSummary } from '@/lib/inbox-types';
import { ChannelBadge } from './channel-badge';

/** Inbox conversation rows (newest activity first); the selected one is highlighted. */
export function ConversationList({
  conversations,
  selectedId,
  hrefFor,
  timezone,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  hrefFor: (id: string) => string;
  timezone: string;
}) {
  const m = getMessages('en');
  if (conversations.length === 0) return <EmptyState title={m.inbox.empty} />;
  return (
    <ul
      aria-label={m.inbox.title}
      className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white shadow-sm"
    >
      {conversations.map((conversation) => {
        const title =
          conversation.contact?.name ??
          conversation.counterpart.name ??
          conversation.counterpart.address;
        const unread = conversation.unreadCount > 0;
        return (
          <li key={conversation.id}>
            <Link
              href={hrefFor(conversation.id)}
              aria-current={conversation.id === selectedId ? 'true' : undefined}
              className={cn(
                'block px-4 py-3 hover:bg-slate-50',
                conversation.id === selectedId && 'bg-brand-50 hover:bg-brand-50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'truncate text-sm',
                    unread ? 'font-semibold text-slate-900' : 'font-medium text-slate-800',
                  )}
                >
                  {title}
                </span>
                <span className="shrink-0 text-xs text-slate-500">
                  {formatDateTime(conversation.lastMessageAt ?? conversation.createdAt, timezone)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <ChannelBadge channel={conversation.channel} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    unread ? 'text-slate-800' : 'text-slate-500',
                  )}
                >
                  {conversation.lastMessageDirection === 'outbound' ? `${m.inbox.you}: ` : ''}
                  {conversation.lastMessagePreview ?? conversation.subject ?? ''}
                </span>
                {unread ? (
                  <span
                    className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white"
                    aria-label={format(m.inbox.unreadBadge, {
                      count: String(conversation.unreadCount),
                    })}
                  >
                    {conversation.unreadCount}
                  </span>
                ) : null}
              </div>
              {conversation.assignee || conversation.tags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                  {conversation.assignee ? (
                    <span className="me-1">→ {conversation.assignee.name ?? '—'}</span>
                  ) : null}
                  {conversation.tags.map((tag) => (
                    <TagBadge key={tag.id} tag={tag} />
                  ))}
                </div>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
