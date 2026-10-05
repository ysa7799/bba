'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { TagBadge } from '@/components/crm/tag-badge';
import { TagPicker } from '@/components/crm/tag-picker';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { inputClass, SelectField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { ApiError, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import type { Assignee, TagSummary } from '@/lib/crm-types';
import { formatDateTime } from '@/lib/format';
import type { ConversationSummary, MessageSummary, TemplateSummary } from '@/lib/inbox-types';
import { ChannelBadge } from './channel-badge';

interface MessagePage {
  data: MessageSummary[];
  nextCursor: string | null;
}

const REFRESH_MS = 15_000;

/**
 * One conversation: messages oldest-first (older pages load on demand), a composer for replies
 * and internal notes, and the assignment/status/tags panel. Opening it marks it read; while
 * visible it refreshes periodically so new messages and delivery receipts appear.
 */
export function ConversationThread({
  conversation,
  initial,
  templates,
  assignees,
  tags,
  timezone,
  currentUserId,
}: {
  conversation: ConversationSummary;
  initial: MessagePage;
  templates: TemplateSummary[];
  assignees: Assignee[];
  tags: TagSummary[];
  timezone: string;
  currentUserId: string;
}) {
  const m = useMessages();
  const router = useRouter();
  const { organizationId } = useOrg();
  const canSend = useCan('communications.send');
  const canAssign = useCan('communications.assign');
  const [older, setOlder] = useState<MessageSummary[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const base = `/app/orgs/${organizationId}/communications/conversations/${conversation.id}`;

  // Server data (refreshed) wins over older client-loaded copies of the same message.
  const messages = useMemo(() => {
    const byId = new Map<string, MessageSummary>();
    for (const message of [...older, ...initial.data]) byId.set(message.id, message);
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }, [older, initial]);
  const cursor = older.length > 0 ? olderCursor : initial.nextCursor;
  const lastId = messages.at(-1)?.id;

  const unread = conversation.unreadCount > 0;
  useEffect(() => {
    if (!unread) return;
    let cancelled = false;
    apiRequest(`${base}/read`, { method: 'POST', body: {} })
      .then(() => {
        if (!cancelled) router.refresh();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base, unread, router]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastId]);

  async function loadOlder() {
    if (!cursor) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await apiRequest<MessagePage>(
        `${base}/messages?${new URLSearchParams({ limit: '30', cursor }).toString()}`,
      );
      setOlder((current) => [...page.data, ...current]);
      setOlderCursor(page.nextCursor);
    } catch (caught) {
      setLoadError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setLoadingOlder(false);
    }
  }

  const title =
    conversation.contact?.name ?? conversation.counterpart.name ?? conversation.counterpart.address;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <section
        aria-labelledby="conversation-title"
        className="flex min-w-0 flex-col rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 id="conversation-title" className="truncate text-base font-semibold text-slate-900">
              {title}
            </h2>
            <p className="truncate text-xs text-slate-500">
              {conversation.counterpart.address}
              {conversation.subject ? ` · ${conversation.subject}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ChannelBadge channel={conversation.channel} />
            {conversation.status === 'closed' ? (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                {m.inbox.statuses.closed}
              </span>
            ) : null}
          </div>
        </header>
        <div
          ref={scrollRef}
          className="max-h-[60vh] min-h-64 space-y-3 overflow-y-auto px-4 py-4"
          aria-live="polite"
          aria-busy={loadingOlder || undefined}
        >
          {cursor ? (
            <div className="text-center">
              <Button size="sm" variant="ghost" loading={loadingOlder} onClick={loadOlder}>
                {m.inbox.loadOlder}
              </Button>
            </div>
          ) : null}
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          <ol className="space-y-3" aria-label={m.inbox.title}>
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} timezone={timezone} />
            ))}
          </ol>
        </div>
        {canSend ? (
          <Composer conversation={conversation} templates={templates} base={base} />
        ) : null}
      </section>
      <ConversationDetails
        conversation={conversation}
        assignees={assignees}
        tags={tags}
        currentUserId={currentUserId}
        canAssign={canAssign}
      />
    </div>
  );
}

function MessageItem({ message, timezone }: { message: MessageSummary; timezone: string }) {
  const m = useMessages();
  const when = formatDateTime(message.createdAt, timezone);
  if (message.direction === 'internal') {
    return (
      <li className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
        <p className="mb-1 text-xs text-amber-800">
          <span className="font-semibold">{m.inbox.internalNote}</span> ·{' '}
          {message.author?.name ?? '—'} · {when}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{message.text}</p>
      </li>
    );
  }
  const outbound = message.direction === 'outbound';
  return (
    <li className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2',
          outbound ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-900',
        )}
      >
        {message.subject ? <p className="mb-1 text-sm font-semibold">{message.subject}</p> : null}
        {message.template ? (
          <p className={cn('mb-1 text-xs', outbound ? 'text-brand-100' : 'text-slate-500')}>
            {m.inbox.template}: {message.template.name} ({message.template.language})
          </p>
        ) : null}
        {message.text ? (
          <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
        ) : null}
        {message.attachments.map((attachment) => (
          <p
            key={attachment.id}
            className={cn('mt-1 text-xs', outbound ? 'text-brand-100' : 'text-slate-500')}
          >
            📎 {attachment.fileName} · {m.inbox.attachmentPending}
          </p>
        ))}
        <p className={cn('mt-1 text-xs', outbound ? 'text-brand-100' : 'text-slate-500')}>
          {outbound && message.author?.name ? `${message.author.name} · ` : ''}
          {when}
          {outbound ? ` · ${m.inbox.messageStatus[message.status]}` : ''}
        </p>
        {message.status === 'failed' ? (
          <p className="mt-1 rounded bg-white/90 px-2 py-1 text-xs text-red-700" role="alert">
            {message.errorMessage ?? message.errorCode ?? m.common.genericError}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function Composer({
  conversation,
  templates,
  base,
}: {
  conversation: ConversationSummary;
  templates: TemplateSummary[];
  base: string;
}) {
  const m = useMessages();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState(
    conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, '')}` : '',
  );
  const { run, pending, error } = useMutation();
  const templateOnly = mode === 'reply' && !conversation.canReplyFreely;

  async function submit(event?: SubmitEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!text.trim() || pending) return;
    const ok = await run(() =>
      mode === 'note'
        ? apiRequest(`${base}/notes`, { body: { text } })
        : apiRequest(`${base}/messages`, {
            body: {
              text,
              ...(conversation.channel === 'email' && subject.trim()
                ? { subject: subject.trim() }
                : {}),
            },
          }),
    );
    if (ok) setText('');
  }

  return (
    <div className="border-t border-slate-200 p-3">
      <div role="tablist" aria-label={m.inbox.reply} className="mb-2 flex gap-1">
        {(['reply', 'note'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium',
              mode === value
                ? value === 'note'
                  ? 'bg-amber-500 text-white'
                  : 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
            )}
          >
            {value === 'reply' ? m.inbox.reply : m.inbox.note}
          </button>
        ))}
      </div>
      {error ? (
        <div className="mb-2">
          <Alert tone="error">{error.fieldError('text') ?? error.message}</Alert>
        </div>
      ) : null}
      {templateOnly ? (
        <TemplateComposer templates={templates} base={base} />
      ) : (
        <form onSubmit={submit} className="space-y-2">
          {mode === 'reply' && conversation.channel === 'email' ? (
            <TextField
              label={m.inbox.subject}
              value={subject}
              maxLength={300}
              onChange={(event) => setSubject(event.target.value)}
            />
          ) : null}
          <label htmlFor="composer-text" className="sr-only">
            {mode === 'note' ? m.inbox.addNote : m.inbox.reply}
          </label>
          <textarea
            id="composer-text"
            rows={3}
            maxLength={10_000}
            className={cn(inputClass, mode === 'note' && 'bg-amber-50')}
            placeholder={mode === 'note' ? m.inbox.notePlaceholder : m.inbox.messagePlaceholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-500">{mode === 'note' ? m.inbox.noteHint : ''}</p>
            <Button type="submit" size="sm" loading={pending} disabled={!text.trim()}>
              {mode === 'note' ? m.inbox.addNote : m.inbox.send}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** WhatsApp outside the 24-hour customer-service window: only approved templates. */
function TemplateComposer({ templates, base }: { templates: TemplateSummary[]; base: string }) {
  const m = useMessages();
  const [templateId, setTemplateId] = useState('');
  const [parameters, setParameters] = useState<string[]>([]);
  const { run, pending, error } = useMutation();
  const template = templates.find((entry) => entry.id === templateId) ?? null;
  const preview = template
    ? template.body.replace(/\{\{(\d+)\}\}/g, (match, n: string) => {
        // Empty inputs keep the placeholder visible in the preview.
        const value = parameters[Number(n) - 1] ?? '';
        return value === '' ? match : value;
      })
    : '';

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!template) return;
    const ok = await run(() =>
      apiRequest(`${base}/messages`, {
        body: {
          template: {
            name: template.name,
            language: template.language,
            parameters: Array.from(
              { length: template.variableCount },
              (_, index) => parameters[index] ?? '',
            ),
          },
        },
      }),
    );
    if (ok) {
      setTemplateId('');
      setParameters([]);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Alert tone="info">{m.inbox.windowClosed}</Alert>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {templates.length === 0 ? (
        <p className="text-sm text-slate-500">{m.inbox.noTemplates}</p>
      ) : (
        <>
          <SelectField
            label={m.inbox.template}
            value={templateId}
            onChange={(event) => {
              setTemplateId(event.target.value);
              setParameters([]);
            }}
          >
            <option value="">{m.inbox.chooseTemplate}</option>
            {templates.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.language})
              </option>
            ))}
          </SelectField>
          {template
            ? Array.from({ length: template.variableCount }, (_, index) => (
                <TextField
                  key={index}
                  label={format(m.inbox.templateParameter, { number: String(index + 1) })}
                  value={parameters[index] ?? ''}
                  maxLength={1_000}
                  onChange={(event) =>
                    setParameters((current) => {
                      const next = [...current];
                      next[index] = event.target.value;
                      return next;
                    })
                  }
                />
              ))
            : null}
          {template ? (
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-sm text-slate-700">
              {preview}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={pending} disabled={!template}>
              {m.inbox.sendTemplate}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function ConversationDetails({
  conversation,
  assignees,
  tags,
  currentUserId,
  canAssign,
}: {
  conversation: ConversationSummary;
  assignees: Assignee[];
  tags: TagSummary[];
  currentUserId: string;
  canAssign: boolean;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [tagIds, setTagIds] = useState(() => conversation.tags.map((tag) => tag.id));
  const path = `/app/orgs/${organizationId}/communications/conversations/${conversation.id}`;
  const patch = (body: Record<string, unknown>) =>
    run(() => apiRequest(path, { method: 'PATCH', body }));
  // Without CRM access the member list is unavailable; still offer self-assignment.
  const options = assignees.some((assignee) => assignee.userId === currentUserId)
    ? [...assignees]
    : [{ userId: currentUserId, name: m.inbox.assignToMe }, ...assignees];
  if (
    conversation.assignee &&
    !options.some((option) => option.userId === conversation.assignee?.userId)
  ) {
    options.push({
      userId: conversation.assignee.userId,
      name: conversation.assignee.name ?? '—',
    });
  }
  const tagsChanged =
    tagIds.length !== conversation.tags.length ||
    conversation.tags.some((tag) => !tagIds.includes(tag.id));

  return (
    <aside
      aria-label={m.inbox.details}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm"
    >
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {m.inbox.contact}
        </p>
        {conversation.contact ? (
          <Link
            href={`/o/${organizationId}/crm/contacts/${conversation.contact.id}`}
            className="mt-1 block font-medium text-brand-600 hover:underline"
          >
            {conversation.contact.name}
          </Link>
        ) : (
          <p className="mt-1 text-slate-500">{m.inbox.noContact}</p>
        )}
        <p className="mt-0.5 break-all text-slate-600">{conversation.counterpart.address}</p>
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {m.inbox.channelLabel}
        </p>
        <p className="mt-1 text-slate-800">{conversation.connection.name}</p>
        <p className="text-slate-500">{conversation.connection.address}</p>
      </div>
      {canAssign ? (
        <>
          <SelectField
            label={m.inbox.assign}
            value={conversation.assignee?.userId ?? ''}
            disabled={pending}
            onChange={(event) => void patch({ assigneeUserId: event.target.value || null })}
          >
            <option value="">{m.inbox.unassigned}</option>
            {options.map((option) => (
              <option key={option.userId} value={option.userId}>
                {option.name}
              </option>
            ))}
          </SelectField>
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            loading={pending}
            onClick={() =>
              void patch({ status: conversation.status === 'open' ? 'closed' : 'open' })
            }
          >
            {conversation.status === 'open' ? m.inbox.close : m.inbox.reopen}
          </Button>
          {tags.length > 0 ? (
            <div className="space-y-2">
              <TagPicker tags={tags} value={tagIds} onChange={setTagIds} />
              {tagsChanged ? (
                <Button size="sm" loading={pending} onClick={() => void patch({ tagIds })}>
                  {m.inbox.saveTags}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-2">
          <p>
            <span className="text-slate-500">{m.inbox.assignee}: </span>
            {conversation.assignee?.name ?? m.inbox.unassigned}
          </p>
          {conversation.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {conversation.tags.map((tag) => (
                <TagBadge key={tag.id} tag={tag} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
