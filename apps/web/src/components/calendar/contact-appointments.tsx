import Link from 'next/link';
import { Section } from '@/components/crm/detail';
import { getMessages } from '@/i18n';
import type { Page } from '@/lib/api-types';
import type {
  AppointmentSummary,
  AppointmentTypeSummary,
  CalendarSummary,
} from '@/lib/calendar-types';
import { requestTime } from '@/lib/clock';
import { serverGetJson } from '@/lib/server-api';
import { formatDateTimeInZone } from '@/lib/zoned-time';
import { NewAppointmentButton } from './new-appointment';

/** Upcoming appointments of a contact, with a "Book" action for members who can schedule. */
export async function ContactAppointments({
  orgId,
  contact,
  timezone,
  canManage,
}: {
  orgId: string;
  contact: { id: string; name: string };
  timezone: string;
  canManage: boolean;
}) {
  const m = getMessages('en');
  const base = `/app/orgs/${orgId}/calendar`;
  const qs = new URLSearchParams({
    contactId: contact.id,
    status: 'scheduled',
    from: new Date(requestTime()).toISOString(),
    limit: '10',
  });
  const [appointments, calendars, types] = await Promise.all([
    serverGetJson<Page<AppointmentSummary>>(`${base}/appointments?${qs.toString()}`),
    canManage
      ? serverGetJson<{ data: CalendarSummary[] }>(`${base}/calendars`)
      : Promise.resolve(null),
    canManage
      ? serverGetJson<{ data: AppointmentTypeSummary[] }>(`${base}/appointment-types`)
      : Promise.resolve(null),
  ]);
  if (!appointments) return null;
  return (
    <Section
      title={m.calendar.upcoming}
      actions={
        calendars && types ? (
          <NewAppointmentButton
            calendars={calendars.data.filter((calendar) => calendar.isActive)}
            types={types.data.filter((type) => type.isActive)}
            timezone={timezone}
            canPickContact
            contact={contact}
          />
        ) : null
      }
    >
      {appointments.data.length === 0 ? (
        <p className="text-sm text-slate-500">{m.calendar.noUpcoming}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {appointments.data.map((appointment) => (
            <li key={appointment.id} className="py-2">
              <Link
                href={`/o/${orgId}/calendar?week=${appointment.startsAt.slice(0, 10)}`}
                className="font-medium hover:underline"
              >
                {appointment.title}
              </Link>
              <p className="text-xs text-slate-500">
                {formatDateTimeInZone(appointment.startsAt, timezone)} ·{' '}
                {appointment.hosts.map((host) => host.name).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
