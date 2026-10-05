import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { FilterSelect, ListFilters, NextPageLink } from '@/components/crm/list-filters';
import { ConversationList } from '@/components/inbox/conversation-list';
import { ConversationThread } from '@/components/inbox/thread';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import { pickFilters } from '@/lib/crm-server';
import type { Assignee, TagSummary } from '@/lib/crm-types';
import type {
  ChannelPublic,
  ConversationSummary,
  MessageSummary,
  TemplateSummary,
} from '@/lib/inbox-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CRM_READ = ['crm.contact.read', 'crm.company.read', 'crm.deal.read', 'crm.task.read'];

/** Only values the API accepts, so a hand-edited URL never turns into an error page. */
function sanitizeFilters(raw: Record<string, string>) {
  const filters: Record<string, string> & { status: string; assignee: string } = {
    status: ['open', 'closed', 'all'].includes(raw.status ?? '') ? (raw.status ?? 'open') : 'open',
    assignee:
      ['me', 'none', 'all'].includes(raw.assignee ?? '') || UUID.test(raw.assignee ?? '')
        ? (raw.assignee ?? 'all')
        : 'all',
  };
  if (raw.q) filters.q = raw.q;
  if (['email', 'whatsapp', 'sms'].includes(raw.channel ?? '')) filters.channel = raw.channel ?? '';
  if (raw.unread === 'true') filters.unread = 'true';
  return filters;
}

export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const [access, me] = await Promise.all([getOrgAccess(orgId), getMe()]);
  if (!access) notFound();
  if (!me) redirect('/login');
  const can = (permission: string) => access.permissions.includes(permission);
  if (!can('communications.read'))
    return <CrmForbidden title={m.inbox.title} message={m.inbox.forbidden} />;

  const filters = sanitizeFilters(
    pickFilters(query, ['q', 'status', 'assignee', 'channel', 'unread']),
  );
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const selectedId = typeof query.c === 'string' && UUID.test(query.c) ? query.c : null;
  const base = `/app/orgs/${orgId}/communications`;
  const crmRead = CRM_READ.some(can);
  const qs = new URLSearchParams({ ...filters, limit: '30', ...(cursor ? { cursor } : {}) });

  const [page, channels, selected, thread, assignees, tags] = await Promise.all([
    serverGetJson<Page<ConversationSummary>>(`${base}/conversations?${qs.toString()}`),
    serverGetJson<{ data: ChannelPublic[] }>(`${base}/channels`),
    selectedId
      ? serverGetJson<{ conversation: ConversationSummary }>(`${base}/conversations/${selectedId}`)
      : Promise.resolve(null),
    selectedId
      ? serverGetJson<Page<MessageSummary>>(`${base}/conversations/${selectedId}/messages?limit=30`)
      : Promise.resolve(null),
    crmRead
      ? serverGetJson<{ data: Assignee[] }>(`/app/orgs/${orgId}/crm/assignees`)
      : Promise.resolve(null),
    crmRead
      ? serverGetJson<{ data: TagSummary[] }>(`/app/orgs/${orgId}/crm/tags`)
      : Promise.resolve(null),
  ]);
  if (!page) notFound();
  const conversation = selected?.conversation ?? null;
  const templates =
    conversation?.channel === 'whatsapp'
      ? await serverGetJson<{ data: TemplateSummary[] }>(
          `${base}/templates?connectionId=${conversation.connection.id}`,
        )
      : null;
  const timezone = me.organizations.find((entry) => entry.id === orgId)?.timezone ?? 'Asia/Bahrain';
  const hrefFor = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ ...filters, ...extra }).toString()}`;
  const nextHref = page.nextCursor
    ? hrefFor({ cursor: page.nextCursor, ...(selectedId ? { c: selectedId } : {}) })
    : null;
  const hasChannels = (channels?.data ?? []).some((channel) => channel.status !== 'disconnected');

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.inbox.title}
        actions={
          can('communications.manage') ? (
            <Link
              href={`/o/${orgId}/inbox/channels`}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {m.inbox.channelsTitle}
            </Link>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className={selectedId ? 'hidden lg:block' : undefined}>
          <ListFilters q={filters.q ?? ''} clearHref={`/o/${orgId}/inbox`}>
            <FilterSelect
              name="status"
              label={m.inbox.status}
              value={filters.status}
              options={[
                { value: 'open', label: m.inbox.statuses.open },
                { value: 'closed', label: m.inbox.statuses.closed },
                { value: 'all', label: m.inbox.statuses.all },
              ]}
            />
            <FilterSelect
              name="assignee"
              label={m.inbox.assignee}
              value={filters.assignee}
              options={[
                { value: 'all', label: m.crm.all },
                { value: 'me', label: m.crm.mine },
                { value: 'none', label: m.crm.unassigned },
                ...(assignees?.data ?? []).map((assignee) => ({
                  value: assignee.userId,
                  label: assignee.name,
                })),
              ]}
            />
            <FilterSelect
              name="channel"
              label={m.inbox.channel}
              value={filters.channel ?? ''}
              options={[
                { value: '', label: m.crm.all },
                { value: 'whatsapp', label: m.inbox.channels.whatsapp },
                { value: 'email', label: m.inbox.channels.email },
                { value: 'sms', label: m.inbox.channels.sms },
              ]}
            />
            <FilterSelect
              name="unread"
              label={m.inbox.unreadOnly}
              value={filters.unread ?? ''}
              options={[
                { value: '', label: m.inbox.unreadFilter.all },
                { value: 'true', label: m.inbox.unreadFilter.true },
              ]}
            />
          </ListFilters>
          {page.data.length === 0 && !hasChannels ? (
            <Alert tone="info">
              {m.inbox.emptyNoChannels}{' '}
              {can('communications.manage') ? (
                <Link href={`/o/${orgId}/inbox/channels`} className="font-medium underline">
                  {m.inbox.connectChannel}
                </Link>
              ) : null}
            </Alert>
          ) : (
            <ConversationList
              conversations={page.data}
              selectedId={selectedId}
              hrefFor={(id) => hrefFor({ c: id })}
              timezone={timezone}
            />
          )}
          <NextPageLink href={nextHref} />
        </div>
        <div className={selectedId ? undefined : 'hidden lg:block'}>
          {conversation && thread ? (
            <>
              <nav className="mb-2 text-sm lg:hidden">
                <Link href={hrefFor({})} className="text-slate-500 hover:underline">
                  ← {m.inbox.title}
                </Link>
              </nav>
              <ConversationThread
                key={conversation.id}
                conversation={conversation}
                initial={thread}
                templates={templates?.data ?? []}
                assignees={assignees?.data ?? []}
                tags={tags?.data ?? []}
                timezone={timezone}
                currentUserId={me.user.id}
              />
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-500">
              {selectedId ? m.inbox.empty : m.inbox.selectConversation}
            </div>
          )}
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
