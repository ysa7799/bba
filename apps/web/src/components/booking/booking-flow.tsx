'use client';

import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore, type SubmitEvent } from 'react';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextAreaField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { ApiError, apiRequest } from '@/lib/api-client';
import type { ManagedAppointment, PublicBookingPage } from '@/lib/calendar-types';
import { cn } from '@/lib/cn';
import {
  addDaysToDate,
  browserTimeZone,
  formatDateTimeInZone,
  formatDayInZone,
  formatTimeInZone,
  startOfZonedDay,
  zonedDate,
} from '@/lib/zoned-time';

const subscribeNever = () => () => undefined;

/** The visitor's time zone after hydration (the organization's during server rendering). */
export function useVisitorTimeZone(fallback: string): string {
  return useSyncExternalStore(
    subscribeNever,
    () => browserTimeZone(fallback),
    () => fallback,
  );
}

type Type = PublicBookingPage['appointmentTypes'][number];

export function BookingFlow({ slug, page }: { slug: string; page: PublicBookingPage }) {
  const m = useMessages();
  const zone = useVisitorTimeZone(page.organization.timezone);
  const [type, setType] = useState<Type | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  // Bumped when a chosen time was taken meanwhile, so the times are fetched again.
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<{ appointment: ManagedAppointment; token: string } | null>(null);

  if (done) {
    return (
      <div className="mt-6 space-y-3" role="status">
        <h2 className="text-lg font-semibold text-slate-900">{m.booking.confirmed}</h2>
        <p className="text-sm text-slate-700">
          {done.appointment.title} · {formatDateTimeInZone(done.appointment.startsAt, zone)}
        </p>
        <p className="text-sm text-slate-600">{m.booking.confirmedText}</p>
        <Link
          href={`/book/manage/${done.token}`}
          className="inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          {m.booking.manageLink}
        </Link>
      </div>
    );
  }
  if (type && slot) {
    return (
      <DetailsStep
        slug={slug}
        type={type}
        startsAt={slot}
        zone={zone}
        onBack={(taken) => {
          setSlot(null);
          if (taken) setAttempt((count) => count + 1);
        }}
        onBooked={setDone}
      />
    );
  }
  if (type) {
    return (
      <TimeStep
        key={`${type.id}-${attempt}`}
        slug={slug}
        type={type}
        zone={zone}
        onBack={() => setType(null)}
        onPick={setSlot}
      />
    );
  }
  return (
    <div className="mt-6">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{m.booking.chooseType}</h2>
      <ul className="space-y-2">
        {page.appointmentTypes.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => setType(entry)}
              className="w-full rounded-md border border-slate-200 px-4 py-3 text-start hover:border-brand-500 hover:bg-brand-50"
            >
              <span className="block text-sm font-medium text-slate-900">{entry.name}</span>
              <span className="text-xs text-slate-500">
                {format(m.booking.minutes, { count: String(entry.durationMinutes) })}
                {entry.description ? ` · ${entry.description}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimeStep({
  slug,
  type,
  zone,
  onBack,
  onPick,
}: {
  slug: string;
  type: Type;
  zone: string;
  onBack: () => void;
  onPick: (startsAt: string) => void;
}) {
  const m = useMessages();
  // Captured once per mount: "today" for the earliest browsable week.
  const [mountedAt] = useState(() => Date.now());
  const [weekStart, setWeekStart] = useState(() => zonedDate(mountedAt, zone));
  const [result, setResult] = useState<{
    key: string;
    slots: string[] | null;
    error: string | null;
  } | null>(null);
  const key = `${zone}|${weekStart}`;

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({
      from: startOfZonedDay(weekStart, zone),
      to: startOfZonedDay(addDaysToDate(weekStart, 7), zone),
    });
    apiRequest<{ data: string[] }>(
      `/public/booking/pages/${slug}/types/${type.id}/slots?${qs.toString()}`,
    )
      .then((response) => {
        if (!cancelled) setResult({ key, slots: response.data, error: null });
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setResult({
            key,
            slots: null,
            error: caught instanceof ApiError ? caught.message : m.common.genericError,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, slug, type.id, weekStart, zone, m.common.genericError]);

  const current = result?.key === key ? result : null;
  const days = Array.from({ length: 7 }, (_, index) => addDaysToDate(weekStart, index));
  const today = zonedDate(mountedAt, zone);
  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          {type.name} · {format(m.booking.minutes, { count: String(type.durationMinutes) })}
        </h2>
        <p className="text-xs text-slate-500">{format(m.booking.timesShownIn, { zone })}</p>
      </div>
      {current?.error ? <Alert tone="error">{current.error}</Alert> : null}
      <div className="flex items-center justify-between">
        <Button
          size="sm"
          variant="ghost"
          disabled={weekStart <= today || current === null}
          onClick={() => setWeekStart(addDaysToDate(weekStart, -7))}
        >
          ← {m.booking.earlier}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={current === null}
          onClick={() => setWeekStart(addDaysToDate(weekStart, 7))}
        >
          {m.booking.later} →
        </Button>
      </div>
      {current === null ? (
        <p className="text-sm text-slate-500" aria-live="polite">
          {m.booking.loading}
        </p>
      ) : current.slots === null ? null : current.slots.length === 0 ? (
        <p className="text-sm text-slate-500">{m.booking.noSlots}</p>
      ) : (
        <div className="space-y-3">
          {days.map((day) => {
            const daySlots = (current.slots ?? []).filter((slot) => zonedDate(slot, zone) === day);
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
                      onClick={() => onPick(slot)}
                      className="rounded-md px-3 py-1.5 text-sm tabular-nums ring-1 ring-inset ring-slate-300 hover:bg-brand-50 hover:ring-brand-500"
                    >
                      {formatTimeInZone(slot, zone)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← {m.booking.back}
      </Button>
    </div>
  );
}

function DetailsStep({
  slug,
  type,
  startsAt,
  zone,
  onBack,
  onBooked,
}: {
  slug: string;
  type: Type;
  startsAt: string;
  zone: string;
  onBack: (taken: boolean) => void;
  onBooked: (result: { appointment: ManagedAppointment; token: string }) => void;
}) {
  const m = useMessages();
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '', website: '' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest<{ appointment: ManagedAppointment; manageToken: string }>(
        `/public/booking/pages/${slug}/book`,
        {
          body: {
            appointmentTypeId: type.id,
            startsAt,
            website: form.website,
            invitee: {
              name: form.name,
              email: form.email,
              timezone: zone,
              ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
              ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
            },
          },
        },
      );
      onBooked({ appointment: result.appointment, token: result.manageToken });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, 'unknown_error', m.common.genericError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">{m.booking.yourDetails}</h2>
      <p className="text-sm text-slate-700">
        {type.name} · {formatDateTimeInZone(startsAt, zone)}
      </p>
      {error ? (
        <Alert tone="error">{error.status === 409 ? m.booking.taken : error.message}</Alert>
      ) : null}
      <TextField
        label={m.booking.name}
        required
        maxLength={200}
        autoComplete="name"
        value={form.name}
        onChange={set('name')}
      />
      <TextField
        label={m.booking.email}
        type="email"
        required
        maxLength={320}
        autoComplete="email"
        value={form.email}
        error={error?.fieldError('invitee.email')}
        onChange={set('email')}
      />
      <TextField
        label={m.booking.phone}
        type="tel"
        maxLength={40}
        autoComplete="tel"
        value={form.phone}
        onChange={set('phone')}
      />
      <TextAreaField
        label={m.booking.notes}
        rows={3}
        maxLength={2_000}
        value={form.notes}
        onChange={set('notes')}
      />
      {/* Honeypot: hidden from people and assistive technology; bots fill it. */}
      <div className={cn('absolute -left-[9999px] h-0 w-0 overflow-hidden')} aria-hidden="true">
        <label>
          {m.booking.website}
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={set('website')}
          />
        </label>
      </div>
      <div className="flex justify-between gap-2 pt-2">
        <Button variant="ghost" onClick={() => onBack(error?.status === 409)}>
          ← {m.booking.back}
        </Button>
        <Button type="submit" loading={pending}>
          {m.booking.confirm}
        </Button>
      </div>
    </form>
  );
}
