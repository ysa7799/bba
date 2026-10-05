'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { ManagedAppointment } from '@/lib/calendar-types';
import {
  addDaysToDate,
  formatDateTimeInZone,
  formatDayInZone,
  formatTimeInZone,
  startOfZonedDay,
  zonedDate,
} from '@/lib/zoned-time';
import { useVisitorTimeZone } from './booking-flow';

/** The invitee's view of their appointment: details, cancel and reschedule. */
export function ManageBooking({
  token,
  appointment: initial,
}: {
  token: string;
  appointment: ManagedAppointment;
}) {
  const m = useMessages();
  const zone = useVisitorTimeZone(initial.timezone);
  const [appointment, setAppointment] = useState(initial);
  const [mode, setMode] = useState<'view' | 'cancel' | 'reschedule'>('view');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/public/booking/manage/${token}`;

  async function act(path: string, body: unknown, message: string | null) {
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest<{ appointment: ManagedAppointment }>(`${base}${path}`, {
        body,
      });
      setAppointment(result.appointment);
      setMode('view');
      setNotice(message);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.status === 409
            ? m.booking.taken
            : caught.message
          : m.common.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">{m.booking.manageTitle}</h1>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="text-slate-500">{m.booking.with}</dt>
        <dd className="text-slate-900">
          {appointment.title} · {appointment.organization.name}
        </dd>
        <dt className="text-slate-500">{m.booking.when}</dt>
        <dd className="text-slate-900">
          {formatDateTimeInZone(appointment.startsAt, zone)}{' '}
          <span className="text-xs text-slate-500">({zone})</span>
        </dd>
        <dt className="text-slate-500">{m.booking.where}</dt>
        <dd className="text-slate-900">
          {appointment.joinUrl ? (
            <a
              href={appointment.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:underline"
            >
              {appointment.joinUrl}
            </a>
          ) : (
            (appointment.locationDetails ?? m.calendar.locations[appointment.locationKind])
          )}
        </dd>
      </dl>
      {appointment.status === 'cancelled' ? (
        <div className="space-y-2">
          <Alert tone="info">{m.booking.cancelled}</Alert>
          {appointment.bookingPageSlug ? (
            <Link
              href={`/book/${appointment.bookingPageSlug}`}
              className="text-sm font-medium text-brand-600 hover:underline"
            >
              {m.booking.bookAgain}
            </Link>
          ) : null}
        </div>
      ) : !appointment.canChange ? (
        <p className="text-sm text-slate-500">{m.booking.past}</p>
      ) : mode === 'view' ? (
        <div className="flex flex-wrap gap-2">
          {appointment.appointmentTypeId ? (
            <Button variant="secondary" onClick={() => setMode('reschedule')}>
              {m.booking.reschedule}
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => setMode('cancel')}>
            {m.booking.cancel}
          </Button>
        </div>
      ) : mode === 'cancel' ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act('/cancel', reason.trim() ? { reason: reason.trim() } : {}, null);
          }}
        >
          <TextField
            label={m.booking.cancelReason}
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setMode('view')}>
              {m.booking.back}
            </Button>
            <Button type="submit" variant="danger" loading={pending}>
              {m.booking.confirmCancel}
            </Button>
          </div>
        </form>
      ) : (
        <RescheduleSlots
          base={base}
          zone={zone}
          pending={pending}
          onBack={() => setMode('view')}
          onPick={(startsAt) => void act('/reschedule', { startsAt }, m.booking.rescheduled)}
        />
      )}
    </div>
  );
}

function RescheduleSlots({
  base,
  zone,
  pending,
  onBack,
  onPick,
}: {
  base: string;
  zone: string;
  pending: boolean;
  onBack: () => void;
  onPick: (startsAt: string) => void;
}) {
  const m = useMessages();
  const [weekStart, setWeekStart] = useState(() => zonedDate(Date.now(), zone));
  const [result, setResult] = useState<{ key: string; slots: string[] } | null>(null);
  const key = `${zone}|${weekStart}`;

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({
      from: startOfZonedDay(weekStart, zone),
      to: startOfZonedDay(addDaysToDate(weekStart, 7), zone),
    });
    apiRequest<{ data: string[] }>(`${base}/slots?${qs.toString()}`)
      .then((response) => {
        if (!cancelled) setResult({ key, slots: response.data });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, slots: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [base, key, weekStart, zone]);

  const current = result?.key === key ? result : null;
  const days = Array.from({ length: 7 }, (_, index) => addDaysToDate(weekStart, index));
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">{format(m.booking.timesShownIn, { zone })}</p>
      <div className="flex justify-between">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setWeekStart(addDaysToDate(weekStart, -7))}
        >
          ← {m.booking.earlier}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart(addDaysToDate(weekStart, 7))}>
          {m.booking.later} →
        </Button>
      </div>
      {current === null ? (
        <p className="text-sm text-slate-500">{m.booking.loading}</p>
      ) : current.slots.length === 0 ? (
        <p className="text-sm text-slate-500">{m.booking.noSlots}</p>
      ) : (
        days.map((day) => {
          const daySlots = current.slots.filter((slot) => zonedDate(slot, zone) === day);
          if (daySlots.length === 0) return null;
          return (
            <div key={day}>
              <p className="mb-1 text-xs font-semibold text-slate-700">{formatDayInZone(day)}</p>
              <div className="flex flex-wrap gap-2">
                {daySlots.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    data-start={slot}
                    disabled={pending}
                    onClick={() => onPick(slot)}
                    className="rounded-md px-3 py-1.5 text-sm tabular-nums ring-1 ring-inset ring-slate-300 hover:bg-brand-50 hover:ring-brand-500 disabled:opacity-60"
                  >
                    {formatTimeInZone(slot, zone)}
                  </button>
                ))}
              </div>
            </div>
          );
        })
      )}
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← {m.booking.back}
      </Button>
    </div>
  );
}
