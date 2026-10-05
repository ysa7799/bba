'use client';

import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type { CalendarSummary } from '@/lib/calendar-types';
import { cn } from '@/lib/cn';

export function CalendarsPanel({
  calendars,
  selectedId,
  defaultTimezone,
}: {
  calendars: CalendarSummary[];
  selectedId: string | null;
  defaultTimezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('calendar.manage');
  const { run, pending, error } = useMutation();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const base = `/app/orgs/${organizationId}/calendar/calendars`;

  async function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(() => apiRequest(base, { body: { name, timezone } }));
    if (ok) setName('');
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">{m.calendar.calendarsHint}</p>
      {error ? <Alert tone="error">{error.message}</Alert> : null}
      <ul className="divide-y divide-slate-100">
        {calendars.map((calendar) => (
          <li key={calendar.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p
                className={cn(
                  'text-sm font-medium text-slate-900',
                  !calendar.isActive && 'text-slate-400',
                )}
              >
                {calendar.name}
              </p>
              <p className="text-xs text-slate-500">
                {calendar.kind === 'user' ? m.calendar.personal : m.calendar.shared} ·{' '}
                {calendar.timezone}
                {calendar.isActive ? '' : ` · ${m.calendar.inactive}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {calendar.id === selectedId ? null : (
                <Link
                  href={`?calendar=${calendar.id}`}
                  className="text-xs font-medium text-brand-600 hover:underline"
                >
                  {m.calendar.editAvailability}
                </Link>
              )}
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={pending}
                  onClick={() =>
                    void run(() =>
                      apiRequest(`${base}/${calendar.id}`, {
                        method: 'PATCH',
                        body: { isActive: !calendar.isActive },
                      }),
                    )
                  }
                >
                  {calendar.isActive ? m.calendar.deactivate : m.calendar.activate}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {canManage ? (
        <form onSubmit={create} className="grid gap-2 sm:grid-cols-3 sm:items-end">
          <TextField
            label={m.calendar.calendarName}
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label={m.calendar.timezone}
            required
            maxLength={64}
            value={timezone}
            error={error?.fieldError('timezone')}
            onChange={(event) => setTimezone(event.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {m.calendar.newCalendar}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
