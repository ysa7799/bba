'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { inputClass, SelectField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import type { Availability, CalendarSummary, WeeklyRule } from '@/lib/calendar-types';
import { formatDayInZone, minutesToTime, timeToMinutes } from '@/lib/zoned-time';

interface DraftRule {
  key: number;
  weekday: number;
  start: string;
  end: string;
}

let nextKey = 0;
const draft = (rule: WeeklyRule): DraftRule => ({
  key: (nextKey += 1),
  weekday: rule.weekday,
  start: minutesToTime(rule.startMinute),
  end: minutesToTime(Math.min(rule.endMinute, 1439)),
});

/** Weekly working hours and date overrides of one calendar (in the calendar's time zone). */
export function AvailabilityEditor({
  calendar,
  availability,
  editable,
}: {
  calendar: CalendarSummary;
  availability: Availability;
  editable: boolean;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [rules, setRules] = useState<DraftRule[]>(() => availability.rules.map(draft));
  const [saved, setSaved] = useState(false);
  const path = `/app/orgs/${organizationId}/calendar/calendars/${calendar.id}`;

  async function save() {
    setSaved(false);
    const payload = rules.map((rule) => ({
      weekday: rule.weekday,
      startMinute: timeToMinutes(rule.start) ?? 0,
      // 23:59 in a time input means "until the end of the day".
      endMinute: rule.end === '23:59' ? 1440 : (timeToMinutes(rule.end) ?? 0),
    }));
    const ok = await run(() =>
      apiRequest(`${path}/availability`, { method: 'PUT', body: { rules: payload } }),
    );
    if (ok) setSaved(true);
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-3 text-xs text-slate-500">
          {format(m.calendar.timesIn, { zone: calendar.timezone })}
        </p>
        {error ? (
          <div className="mb-3">
            <Alert tone="error">{error.message}</Alert>
          </div>
        ) : null}
        {saved ? (
          <div className="mb-3">
            <Alert tone="success">{m.calendar.hoursSaved}</Alert>
          </div>
        ) : null}
        <ul className="divide-y divide-slate-100">
          {m.calendar.weekdays.map((dayName, weekday) => {
            const day = rules.filter((rule) => rule.weekday === weekday);
            return (
              <li key={dayName} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-28 text-sm font-medium text-slate-800">{dayName}</span>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  {day.length === 0 ? (
                    <span className="text-sm text-slate-400">{m.calendar.unavailable}</span>
                  ) : null}
                  {day.map((rule) => (
                    <span key={rule.key} className="flex items-center gap-1">
                      <input
                        type="time"
                        aria-label={`${dayName} ${m.calendar.from}`}
                        className={`${inputClass} w-28`}
                        value={rule.start}
                        disabled={!editable}
                        onChange={(event) =>
                          setRules((current) =>
                            current.map((entry) =>
                              entry.key === rule.key
                                ? { ...entry, start: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                      <span className="text-slate-400">–</span>
                      <input
                        type="time"
                        aria-label={`${dayName} ${m.calendar.to}`}
                        className={`${inputClass} w-28`}
                        value={rule.end}
                        disabled={!editable}
                        onChange={(event) =>
                          setRules((current) =>
                            current.map((entry) =>
                              entry.key === rule.key
                                ? { ...entry, end: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                      {editable ? (
                        <button
                          type="button"
                          className="px-1 text-xs text-red-600 hover:text-red-800"
                          aria-label={`${m.calendar.remove} ${dayName} ${rule.start}`}
                          onClick={() =>
                            setRules((current) => current.filter((entry) => entry.key !== rule.key))
                          }
                        >
                          {m.calendar.remove}
                        </button>
                      ) : null}
                    </span>
                  ))}
                  {editable ? (
                    <button
                      type="button"
                      className="text-xs font-medium text-brand-600 hover:underline"
                      onClick={() =>
                        setRules((current) => [
                          ...current,
                          draft({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }),
                        ])
                      }
                    >
                      + {m.calendar.addHours}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {editable ? (
          <div className="mt-3">
            <Button size="sm" loading={pending} onClick={() => void save()}>
              {m.calendar.saveHours}
            </Button>
          </div>
        ) : null}
      </div>
      <Overrides path={path} exceptions={availability.exceptions} editable={editable} />
    </div>
  );
}

function Overrides({
  path,
  exceptions,
  editable,
}: {
  path: string;
  exceptions: Availability['exceptions'];
  editable: boolean;
}) {
  const m = useMessages();
  const { run, pending, error } = useMutation();
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<'unavailable' | 'available'>('unavailable');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const startMinute = start ? timeToMinutes(start) : null;
    const endMinute = end ? (end === '23:59' ? 1440 : timeToMinutes(end)) : null;
    const ok = await run(() =>
      apiRequest(`${path}/exceptions`, {
        body: { date, kind, startMinute, endMinute, reason: reason.trim() || null },
      }),
    );
    if (ok) {
      setDate('');
      setStart('');
      setEnd('');
      setReason('');
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">{m.calendar.overrides}</h3>
      <p className="mb-2 text-xs text-slate-500">{m.calendar.overridesHint}</p>
      {error ? (
        <div className="mb-2">
          <Alert tone="error">{error.message}</Alert>
        </div>
      ) : null}
      {exceptions.length === 0 ? (
        <p className="text-sm text-slate-500">{m.calendar.noOverrides}</p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm">
          {exceptions.map((exception) => (
            <li key={exception.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-800">{formatDayInZone(exception.date)}</span>
              <span className="text-slate-600">
                {exception.kind === 'unavailable' ? m.calendar.dayOff : m.calendar.customHours}
                {exception.startMinute !== null && exception.endMinute !== null
                  ? ` ${minutesToTime(exception.startMinute)}–${minutesToTime(exception.endMinute)}`
                  : ` (${m.calendar.allDay})`}
                {exception.reason ? ` · ${exception.reason}` : ''}
              </span>
              {editable ? (
                <button
                  type="button"
                  className="text-xs text-red-600 hover:text-red-800"
                  onClick={() =>
                    void run(() =>
                      apiRequest(`${path}/exceptions/${exception.id}`, { method: 'DELETE' }),
                    )
                  }
                >
                  {m.calendar.remove}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-6 sm:items-end">
          <TextField
            label={m.calendar.overrideDate}
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <SelectField
            label={m.calendar.overrideKind}
            value={kind}
            onChange={(event) => setKind(event.target.value as 'unavailable' | 'available')}
          >
            <option value="unavailable">{m.calendar.dayOff}</option>
            <option value="available">{m.calendar.customHours}</option>
          </SelectField>
          <TextField
            label={m.calendar.from}
            type="time"
            required={kind === 'available'}
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
          <TextField
            label={m.calendar.to}
            type="time"
            required={kind === 'available' || start !== ''}
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
          <TextField
            label={m.calendar.cancelReason}
            maxLength={200}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary" loading={pending}>
            {m.calendar.addOverride}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
