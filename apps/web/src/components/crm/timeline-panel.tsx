'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import {
  LOGGABLE_ACTIVITY_TYPES,
  type ActivityCategory,
  type ActivitySummary,
} from '@/lib/crm-types';
import { formatDateTime, fromDateTimeLocal, toDateTimeLocal } from '@/lib/format';

const CATEGORY_STYLES: Record<ActivityCategory, string> = {
  note: 'bg-amber-400',
  task: 'bg-sky-500',
  deal: 'bg-emerald-500',
  communication: 'bg-purple-500',
  appointment: 'bg-indigo-500',
  form: 'bg-teal-500',
  record: 'bg-slate-400',
};

const CATEGORIES = [
  'all',
  'note',
  'task',
  'deal',
  'communication',
  'appointment',
  'form',
  'record',
] as const;

interface Page {
  data: ActivitySummary[];
  nextCursor: string | null;
}

/**
 * Unified activity timeline of a contact, company or deal: projected history plus logged calls,
 * meetings and messages. Server-rendered first page; filters and older pages load client-side.
 */
export function TimelinePanel({
  record,
  initial,
  timezone,
  currentUserId,
}: {
  record: { kind: 'contacts' | 'companies' | 'deals'; id: string };
  initial: Page;
  timezone: string;
  currentUserId: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canLog = useCan('crm.activity.log');
  const canModerate = useCan('crm.activity.manage');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('all');
  const [page, setPage] = useState<Page>(initial);
  const [source, setSource] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/app/orgs/${organizationId}/crm/${record.kind}/${record.id}/timeline`;

  // Fresh server data (after a mutation refresh) replaces the client copy for the "all" view.
  if (source !== initial) {
    setSource(initial);
    if (category === 'all') setPage(initial);
  }

  async function load(nextCategory: (typeof CATEGORIES)[number], cursor?: string) {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '25' });
      if (nextCategory !== 'all') qs.set('category', nextCategory);
      if (cursor) qs.set('cursor', cursor);
      const result = await apiRequest<Page>(`${base}?${qs.toString()}`);
      setPage((current) =>
        cursor
          ? { data: [...current.data, ...result.data], nextCursor: result.nextCursor }
          : result,
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : m.common.genericError);
    } finally {
      setLoading(false);
    }
  }

  const link =
    record.kind === 'contacts'
      ? { contactId: record.id }
      : record.kind === 'companies'
        ? { companyId: record.id }
        : { dealId: record.id };

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      aria-labelledby="timeline-title"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline-title" className="text-sm font-semibold text-slate-900">
          {m.crm.timeline.title}
        </h2>
        {canLog ? <LogActivityButton link={link} /> : null}
      </div>
      <div role="tablist" aria-label={m.crm.timeline.title} className="mb-3 flex flex-wrap gap-1">
        {CATEGORIES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={category === value}
            onClick={() => {
              setCategory(value);
              void load(value);
            }}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium',
              category === value
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
            )}
          >
            {m.crm.timeline.categories[value]}
          </button>
        ))}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {page.data.length === 0 ? (
        <p className="text-sm text-slate-500">
          {m.crm.timeline.empty}{' '}
          <span className="text-slate-400">{m.crm.timeline.projectionHint}</span>
        </p>
      ) : (
        <ol
          className="relative space-y-4 border-s border-slate-200 ps-5"
          aria-busy={loading || undefined}
        >
          {page.data.map((activity) => {
            const details =
              typeof activity.metadata.details === 'string' ? activity.metadata.details : null;
            const canDelete =
              activity.manual && (canModerate || activity.actor.userId === currentUserId);
            return (
              <li key={activity.id} className="relative" data-testid="timeline-item">
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -start-[1.65rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white',
                    CATEGORY_STYLES[activity.category],
                  )}
                />
                <p className="text-sm text-slate-900">
                  {activity.manual && activity.type in m.crm.timeline.kinds ? (
                    <span className="me-1.5 rounded bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700">
                      {m.crm.timeline.kinds[activity.type as keyof typeof m.crm.timeline.kinds]}
                      {typeof activity.metadata.direction === 'string'
                        ? ` · ${activity.metadata.direction === 'inbound' ? m.crm.timeline.inbound : m.crm.timeline.outbound}`
                        : ''}
                    </span>
                  ) : null}
                  {activity.summary}
                </p>
                {details ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{details}</p>
                ) : null}
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatDateTime(activity.occurredAt, timezone)} ·{' '}
                  {activity.actor.name ?? m.crm.timeline.system}
                  {canDelete ? (
                    <button
                      type="button"
                      className="ms-2 font-medium text-slate-500 hover:text-red-700"
                      onClick={() => {
                        if (!window.confirm(m.crm.timeline.deleteConfirm)) return;
                        void apiRequest(
                          `/app/orgs/${organizationId}/crm/activities/${activity.id}`,
                          { method: 'DELETE' },
                        )
                          .then(() =>
                            setPage((current) => ({
                              ...current,
                              data: current.data.filter((row) => row.id !== activity.id),
                            })),
                          )
                          .catch((caught: unknown) =>
                            setError(
                              caught instanceof ApiError ? caught.message : m.common.genericError,
                            ),
                          );
                      }}
                    >
                      {m.crm.delete}
                    </button>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {page.nextCursor ? (
        <div className="mt-4">
          <Button
            size="sm"
            variant="ghost"
            loading={loading}
            onClick={() => void load(category, page.nextCursor ?? undefined)}
          >
            {m.crm.timeline.loadMore}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function LogActivityButton({
  link,
}: {
  link: { contactId?: string; companyId?: string; dealId?: string };
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const [open, setOpen] = useState(false);
  const [now] = useState(() => toDateTimeLocal(new Date().toISOString()));
  const [form, setForm] = useState({
    type: 'call.logged' as (typeof LOGGABLE_ACTIVITY_TYPES)[number],
    summary: '',
    details: '',
    direction: 'outbound',
    durationMinutes: '',
    outcome: '',
    occurredAt: now,
  });
  const { run, pending, error, reset } = useMutation();
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const hasDirection = form.type !== 'meeting.logged';
  const hasDuration = form.type === 'call.logged' || form.type === 'meeting.logged';

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/crm/activities`, {
        body: {
          type: form.type,
          summary: form.summary,
          details: form.details,
          ...(hasDirection ? { direction: form.direction } : {}),
          ...(hasDuration && form.durationMinutes.trim() !== ''
            ? { durationMinutes: Number.parseInt(form.durationMinutes, 10) }
            : {}),
          outcome: form.outcome,
          occurredAt: fromDateTimeLocal(form.occurredAt) ?? undefined,
          ...link,
        },
      }),
    );
    if (ok) {
      setOpen(false);
      setForm((current) => ({
        ...current,
        summary: '',
        details: '',
        durationMinutes: '',
        outcome: '',
      }));
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {m.crm.timeline.log}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={m.crm.timeline.logTitle}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && error.code !== 'validation_error' ? (
            <Alert tone="error">{error.message}</Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField label={m.crm.timeline.kind} value={form.type} onChange={set('type')}>
              {LOGGABLE_ACTIVITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {m.crm.timeline.kinds[type]}
                </option>
              ))}
            </SelectField>
            <TextField
              label={m.crm.timeline.when}
              type="datetime-local"
              value={form.occurredAt}
              onChange={set('occurredAt')}
              error={error?.fieldError('occurredAt')}
            />
          </div>
          <TextField
            label={m.crm.timeline.summary}
            value={form.summary}
            onChange={set('summary')}
            maxLength={300}
            required
            autoFocus
            error={error?.fieldError('summary')}
          />
          <TextAreaField
            label={m.crm.timeline.details}
            rows={3}
            value={form.details}
            onChange={set('details')}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            {hasDirection ? (
              <SelectField
                label={m.crm.timeline.direction}
                value={form.direction}
                onChange={set('direction')}
              >
                <option value="outbound">{m.crm.timeline.outbound}</option>
                <option value="inbound">{m.crm.timeline.inbound}</option>
              </SelectField>
            ) : null}
            {hasDuration ? (
              <TextField
                label={m.crm.timeline.duration}
                inputMode="numeric"
                value={form.durationMinutes}
                onChange={set('durationMinutes')}
                error={error?.fieldError('durationMinutes')}
              />
            ) : null}
            <TextField
              label={m.crm.timeline.outcome}
              value={form.outcome}
              onChange={set('outcome')}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.crm.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
