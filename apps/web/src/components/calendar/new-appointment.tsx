'use client';

import { useState, type SubmitEvent } from 'react';
import { useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { RecordPicker, type PickedRecord } from '@/components/crm/record-picker';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { format } from '@/i18n';
import { apiRequest } from '@/lib/api-client';
import type { AppointmentTypeSummary, CalendarSummary } from '@/lib/calendar-types';
import { zonedInputToIso } from '@/lib/zoned-time';

/** Staff booking: an appointment type (hosts and rules) or an ad-hoc slot on a calendar. */
export function NewAppointmentButton({
  calendars,
  types,
  timezone,
  canPickContact,
  contact = null,
}: {
  calendars: CalendarSummary[];
  types: AppointmentTypeSummary[];
  timezone: string;
  canPickContact: boolean;
  /** Pre-selected contact (booking from a contact page). */
  contact?: PickedRecord | null;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error, reset } = useMutation();
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [calendarId, setCalendarId] = useState('');
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState('30');
  const [startsAt, setStartsAt] = useState('');
  const [picked, setPicked] = useState<PickedRecord | null>(contact);
  const [inviteeName, setInviteeName] = useState('');
  const [inviteeEmail, setInviteeEmail] = useState('');
  const [ignoreAvailability, setIgnoreAvailability] = useState(false);
  const type = types.find((entry) => entry.id === typeId) ?? null;
  const hostOptions = type
    ? calendars.filter((calendar) => type.hosts.some((host) => host.calendarId === calendar.id))
    : calendars;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = zonedInputToIso(startsAt, timezone);
    if (!start) return;
    const ok = await run(() =>
      apiRequest(`/app/orgs/${organizationId}/calendar/appointments`, {
        body: {
          startsAt: start,
          ...(type ? { appointmentTypeId: type.id } : { title, durationMinutes: Number(duration) }),
          ...(calendarId ? { calendarId } : {}),
          ...(picked ? { contactId: picked.id } : {}),
          ...(inviteeEmail.trim()
            ? {
                invitee: {
                  email: inviteeEmail.trim(),
                  ...(inviteeName.trim() ? { name: inviteeName.trim() } : {}),
                  timezone,
                },
              }
            : {}),
          ignoreAvailability,
        },
      }),
    );
    if (ok) {
      setOpen(false);
      setStartsAt('');
      setInviteeEmail('');
      setInviteeName('');
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{m.calendar.newAppointment}</Button>
      <Dialog
        open={open}
        onClose={() => {
          reset();
          setOpen(false);
        }}
        title={m.calendar.newTitle}
      >
        <form onSubmit={submit} className="space-y-3">
          {error ? <Alert tone="error">{error.message}</Alert> : null}
          <SelectField
            label={m.calendar.appointmentType}
            value={typeId}
            onChange={(event) => {
              setTypeId(event.target.value);
              setCalendarId('');
            }}
          >
            {types.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.durationMinutes} min)
              </option>
            ))}
            <option value="">{m.calendar.noType}</option>
          </SelectField>
          <SelectField
            label={m.calendar.host}
            value={calendarId}
            required={!type}
            onChange={(event) => setCalendarId(event.target.value)}
          >
            <option value="">{type ? m.calendar.anyHost : '—'}</option>
            {hostOptions.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </SelectField>
          {type ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label={m.calendar.titleLabel}
                required
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <TextField
                label={m.calendar.duration}
                type="number"
                min={5}
                max={720}
                required
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              />
            </div>
          )}
          <TextField
            label={m.calendar.startsAt}
            type="datetime-local"
            required
            value={startsAt}
            hint={format(m.calendar.timesIn, { zone: timezone })}
            error={error?.fieldError('startsAt')}
            onChange={(event) => setStartsAt(event.target.value)}
          />
          {canPickContact ? (
            <RecordPicker
              label={m.calendar.contact}
              type="contact"
              value={picked}
              onChange={setPicked}
            />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={m.calendar.inviteeName}
              maxLength={200}
              value={inviteeName}
              onChange={(event) => setInviteeName(event.target.value)}
            />
            <TextField
              label={m.calendar.inviteeEmail}
              type="email"
              maxLength={320}
              value={inviteeEmail}
              hint={m.calendar.inviteeEmailHint}
              error={error?.fieldError('invitee.email')}
              onChange={(event) => setInviteeEmail(event.target.value)}
            />
          </div>
          <CheckboxField
            label={m.calendar.ignoreAvailability}
            checked={ignoreAvailability}
            onChange={(event) => setIgnoreAvailability(event.target.checked)}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {m.common.cancel}
            </Button>
            <Button type="submit" loading={pending}>
              {m.calendar.book}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
