'use client';

import { useState, type SubmitEvent } from 'react';
import { useCan, useOrg } from '@/components/app/org-access';
import { useMutation } from '@/components/app/use-mutation';
import { useMessages } from '@/components/i18n-provider';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/lib/api-client';
import type {
  AppointmentTypeSummary,
  CalendarSummary,
  LocationKind,
  SchedulingMode,
} from '@/lib/calendar-types';

const MODES: SchedulingMode[] = ['individual', 'round_robin', 'collective'];
const LOCATIONS: LocationKind[] = ['in_person', 'phone', 'video', 'custom'];

export function AppointmentTypesPanel({
  types,
  calendars,
}: {
  types: AppointmentTypeSummary[];
  calendars: CalendarSummary[];
}) {
  const m = useMessages();
  const canManage = useCan('calendar.manage');
  const [editing, setEditing] = useState<AppointmentTypeSummary | 'new' | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">{m.calendar.typesHint}</p>
        {canManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {m.calendar.newType}
          </Button>
        ) : null}
      </div>
      {types.length === 0 ? (
        <EmptyState title={m.calendar.noTypes} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {types.map((type) => (
            <li key={type.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {type.name}
                  {type.isActive ? '' : ` · ${m.calendar.inactive}`}
                </p>
                <p className="text-xs text-slate-500">
                  {type.durationMinutes} min · {m.calendar.modes[type.schedulingMode]} ·{' '}
                  {type.hosts.map((host) => host.name).join(', ')} ·{' '}
                  {m.calendar.locations[type.locationKind]}
                </p>
              </div>
              {canManage ? (
                <Button size="sm" variant="secondary" onClick={() => setEditing(type)}>
                  {m.crm.edit}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <TypeDialog
          type={editing === 'new' ? null : editing}
          calendars={calendars}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function TypeDialog({
  type,
  calendars,
  onClose,
}: {
  type: AppointmentTypeSummary | null;
  calendars: CalendarSummary[];
  onClose: () => void;
}) {
  const m = useMessages();
  const { organizationId } = useOrg();
  const { run, pending, error } = useMutation();
  const [form, setForm] = useState(() => ({
    name: type?.name ?? '',
    description: type?.description ?? '',
    durationMinutes: String(type?.durationMinutes ?? 30),
    bufferBeforeMinutes: String(type?.bufferBeforeMinutes ?? 0),
    bufferAfterMinutes: String(type?.bufferAfterMinutes ?? 0),
    slotIntervalMinutes: String(type?.slotIntervalMinutes ?? 30),
    minimumNoticeMinutes: String(type?.minimumNoticeMinutes ?? 60),
    maximumAdvanceDays: String(type?.maximumAdvanceDays ?? 60),
    schedulingMode: type?.schedulingMode ?? 'individual',
    locationKind: type?.locationKind ?? 'in_person',
    locationDetails: type?.locationDetails ?? '',
    isActive: type?.isActive ?? true,
    hostCalendarIds: type?.hosts.map((host) => host.calendarId) ?? [],
  }));
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const number = (value: string) => Number(value);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = {
      name: form.name,
      description: form.description.trim() || null,
      durationMinutes: number(form.durationMinutes),
      bufferBeforeMinutes: number(form.bufferBeforeMinutes),
      bufferAfterMinutes: number(form.bufferAfterMinutes),
      slotIntervalMinutes: number(form.slotIntervalMinutes),
      minimumNoticeMinutes: number(form.minimumNoticeMinutes),
      maximumAdvanceDays: number(form.maximumAdvanceDays),
      schedulingMode: form.schedulingMode,
      locationKind: form.locationKind,
      locationDetails: form.locationDetails.trim() || null,
      isActive: form.isActive,
      hostCalendarIds: form.hostCalendarIds,
    };
    const base = `/app/orgs/${organizationId}/calendar/appointment-types`;
    const ok = await run(() =>
      type
        ? apiRequest(`${base}/${type.id}`, { method: 'PATCH', body })
        : apiRequest(base, { body }),
    );
    if (ok) onClose();
  }

  return (
    <Dialog open onClose={onClose} title={type ? m.calendar.editType : m.calendar.newType}>
      <form onSubmit={submit} className="space-y-3">
        {error ? <Alert tone="error">{error.message}</Alert> : null}
        <TextField
          label={m.calendar.typeName}
          required
          maxLength={100}
          value={form.name}
          onChange={set('name')}
        />
        <TextAreaField
          label={m.calendar.description}
          rows={2}
          maxLength={2_000}
          value={form.description}
          onChange={set('description')}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label={m.calendar.duration}
            type="number"
            min={5}
            max={720}
            required
            value={form.durationMinutes}
            onChange={set('durationMinutes')}
          />
          <TextField
            label={m.calendar.bufferBefore}
            type="number"
            min={0}
            max={240}
            value={form.bufferBeforeMinutes}
            onChange={set('bufferBeforeMinutes')}
          />
          <TextField
            label={m.calendar.bufferAfter}
            type="number"
            min={0}
            max={240}
            value={form.bufferAfterMinutes}
            onChange={set('bufferAfterMinutes')}
          />
          <TextField
            label={m.calendar.interval}
            type="number"
            min={5}
            max={240}
            value={form.slotIntervalMinutes}
            onChange={set('slotIntervalMinutes')}
          />
          <TextField
            label={m.calendar.minimumNotice}
            type="number"
            min={0}
            max={43_200}
            value={form.minimumNoticeMinutes}
            onChange={set('minimumNoticeMinutes')}
          />
          <TextField
            label={m.calendar.maximumAdvance}
            type="number"
            min={1}
            max={365}
            value={form.maximumAdvanceDays}
            onChange={set('maximumAdvanceDays')}
          />
        </div>
        <SelectField
          label={m.calendar.mode}
          value={form.schedulingMode}
          onChange={set('schedulingMode')}
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {m.calendar.modes[mode]}
            </option>
          ))}
        </SelectField>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-slate-800">{m.calendar.hosts}</legend>
          {error?.fieldError('hostCalendarIds') ? (
            <p className="text-sm text-red-600">{error.fieldError('hostCalendarIds')}</p>
          ) : null}
          {calendars.map((calendar) => (
            <CheckboxField
              key={calendar.id}
              label={calendar.name}
              checked={form.hostCalendarIds.includes(calendar.id)}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  hostCalendarIds: event.target.checked
                    ? [...current.hostCalendarIds, calendar.id]
                    : current.hostCalendarIds.filter((id) => id !== calendar.id),
                }))
              }
            />
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={m.calendar.location}
            value={form.locationKind}
            onChange={set('locationKind')}
          >
            {LOCATIONS.map((location) => (
              <option key={location} value={location}>
                {m.calendar.locations[location]}
              </option>
            ))}
          </SelectField>
          <TextField
            label={m.calendar.locationDetails}
            maxLength={500}
            value={form.locationDetails}
            onChange={set('locationDetails')}
          />
        </div>
        <CheckboxField
          label={m.calendar.active}
          checked={form.isActive}
          onChange={(event) =>
            setForm((current) => ({ ...current, isActive: event.target.checked }))
          }
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {m.common.cancel}
          </Button>
          <Button type="submit" loading={pending}>
            {m.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
