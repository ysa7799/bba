'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CheckboxField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import type { AppointmentStatus, AppointmentSummary } from '@/lib/calendar-types';
import { cn } from '@/lib/cn';
import {
  addDaysToDate,
  formatDayInZone,
  formatTimeInZone,
  isoToZonedInput,
  zonedDate,
  zonedInputToIso,
} from '@/lib/zoned-time';

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  scheduled: 'bg-sky-50 text-sky-700 ring-sky-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-slate-200',
  no_show: 'bg-amber-50 text-amber-800 ring-amber-200',
};

/** One week of appointments, grouped by day in the organization's time zone. */
export function AppointmentAgenda({
  weekStart,
  appointments,
  timezone,
}: {
  weekStart: string;
  appointments: AppointmentSummary[];
  timezone: string;
}) {
  const m = useMessages();
  if (appointments.length === 0) return <EmptyState title={m.calendar.noAppointments} />;
  const days = Array.from({ length: 7 }, (_, index) => addDaysToDate(weekStart, index));
  return (
    <div className="space-y-4">
      {days.map((day) => {
        const items = appointments.filter((item) => zonedDate(item.startsAt, timezone) === day);
        if (items.length === 0) return null;
        return (
          <section key={day} aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} className="mb-2 text-sm font-semibold text-slate-700">
              {formatDayInZone(day)}
            </h2>
            <ul className="space-y-2">
              {items.map((appointment) => (
                <AppointmentRow
                  key={appointment.id}
                  appointment={appointment}
                  timezone={timezone}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AppointmentRow({
  appointment,
  timezone,
}: {
  appointment: AppointmentSummary;
  timezone: string;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const canManage = useCan('calendar.appointment.manage');
  const { run, pending, error } = useMutation();
  const [dialog, setDialog] = useState<'cancel' | 'reschedule' | null>(null);
  const [reason, setReason] = useState('');
  const [newTime, setNewTime] = useState(() => isoToZonedInput(appointment.startsAt, timezone));
  const [ignoreAvailability, setIgnoreAvailability] = useState(false);
  // Captured once per mount: whether the meeting has started (for completed / no-show).
  const [now] = useState(() => Date.now());
  const path = `/app/orgs/${organizationId}/calendar/appointments/${appointment.id}`;
  const who = appointment.contact?.name ?? appointment.invitee.name;
  const started = Date.parse(appointment.startsAt) <= now;

  return (
    <li
      className={cn(
        'rounded-lg border border-slate-200 bg-white p-3 shadow-sm',
        appointment.status === 'cancelled' && 'opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            <span className="tabular-nums">
              {formatTimeInZone(appointment.startsAt, timezone)}–
              {formatTimeInZone(appointment.endsAt, timezone)}
            </span>{' '}
            {appointment.title}
            {who ? (
              <span className="font-normal text-slate-600">
                {' '}
                {format(m.calendar.with, { name: who })}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {appointment.hosts.map((host) => host.name).join(', ')} ·{' '}
            {m.calendar.locations[appointment.locationKind]}
            {appointment.locationDetails ? ` · ${appointment.locationDetails}` : ''} ·{' '}
            {m.calendar.source[appointment.source]}
          </p>
          {appointment.contact ? (
            <Link
              href={`/o/${organizationId}/crm/contacts/${appointment.contact.id}`}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              {appointment.contact.name}
            </Link>
          ) : appointment.invitee.email ? (
            <p className="text-xs text-slate-500">{appointment.invitee.email}</p>
          ) : null}
          {appointment.notes ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">
              {appointment.notes}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
              STATUS_STYLES[appointment.status],
            )}
          >
            {m.calendar.statuses[appointment.status]}
          </span>
          {appointment.joinUrl && appointment.status === 'scheduled' ? (
            <a
              href={appointment.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              {m.calendar.join}
            </a>
          ) : null}
          {canManage && appointment.status === 'scheduled' ? (
            <>
              {started ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={pending}
                    onClick={() =>
                      void run(() =>
                        apiRequest(`${path}/status`, { body: { status: 'completed' } }),
                      )
                    }
                  >
                    {m.calendar.markCompleted}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending}
                    onClick={() =>
                      void run(() => apiRequest(`${path}/status`, { body: { status: 'no_show' } }))
                    }
                  >
                    {m.calendar.markNoShow}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setDialog('reschedule')}>
                  {m.calendar.reschedule}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setDialog('cancel')}>
                {m.calendar.cancel}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {error && dialog === null ? (
        <div className="mt-2">
          <Alert tone="error">{error.message}</Alert>
        </div>
      ) : null}
      <Dialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title={m.calendar.cancelTitle}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              apiRequest(`${path}/cancel`, {
                body: reason.trim() ? { reason: reason.trim() } : {},
              }),
            ).then((ok) => {
              if (ok) setDialog(null);
            });
          }}
        >
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={m.calendar.cancelReason}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {m.calendar.keep}
            </Button>
            <Button type="submit" variant="danger" loading={pending}>
              {m.calendar.cancel}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={dialog === 'reschedule'}
        onClose={() => setDialog(null)}
        title={m.calendar.rescheduleTitle}
      >
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const startsAt = zonedInputToIso(newTime, timezone);
            if (!startsAt) return;
            void run(() =>
              apiRequest(`${path}/reschedule`, { body: { startsAt, ignoreAvailability } }),
            ).then((ok) => {
              if (ok) setDialog(null);
            });
          }}
        >
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <TextField
            label={m.calendar.newTime}
            type="datetime-local"
            required
            value={newTime}
            hint={format(m.calendar.timesIn, { zone: timezone })}
            onChange={(event) => setNewTime(event.target.value)}
          />
          <CheckboxField
            label={m.calendar.ignoreAvailability}
            checked={ignoreAvailability}
            onChange={(event) => setIgnoreAvailability(event.target.checked)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.calendar.move}
            </Button>
          </div>
        </form>
      </Dialog>
    </li>
  );
}
