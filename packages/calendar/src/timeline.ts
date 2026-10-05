import type { ActivityProjector, ActivityType, ProjectorMap } from '@businessos/activities';
import { appointments } from '@businessos/database';
import type { EventPayload } from '@businessos/events';
import { eq } from 'drizzle-orm';

/** "Sun, 10 Jan 2027, 10:00 (Asia/Bahrain)" — an English snapshot like other timeline summaries. */
export function formatAppointmentTime(start: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(start);
  return `${formatted} (${timeZone})`;
}

function projector(
  type: ActivityType,
  describe: (title: string, when: string, by: string | null) => string,
): ActivityProjector {
  return async (tx, event) => {
    const payload = event.payload as { appointmentId: string; by?: string; to?: string };
    const [row] = await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, payload.appointmentId));
    if (!row?.contactId) return null;
    const when = formatAppointmentTime(row.startsAt, row.timezone);
    return {
      type,
      subject: { type: 'appointment', id: row.id },
      contactId: row.contactId,
      summary: describe(row.title, when, payload.by ?? null),
      metadata: {
        appointmentId: row.id,
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        by: payload.by ?? null,
      },
    };
  };
}

const statusChanged: ActivityProjector = async (tx, event) => {
  const payload = event.payload as EventPayload<'appointment.status_changed'>;
  const type =
    payload.to === 'completed'
      ? 'appointment.completed'
      : payload.to === 'no_show'
        ? 'appointment.no_show'
        : null;
  if (!type) return null;
  return projector(type, (title, when) =>
    type === 'appointment.completed'
      ? `${title} completed (${when})`
      : `Did not attend ${title} (${when})`,
  )(tx, event);
};

/** Appointments on the contact timeline (visible with `calendar.appointment.read`). */
export const calendarTimelineProjectors: ProjectorMap = {
  'appointment.booked': projector(
    'appointment.booked',
    (title, when) => `Booked ${title} for ${when}`,
  ),
  'appointment.rescheduled': projector(
    'appointment.rescheduled',
    (title, when, by) => `${title} moved to ${when}${by === 'invitee' ? ' by the customer' : ''}`,
  ),
  'appointment.cancelled': projector(
    'appointment.cancelled',
    (title, when, by) =>
      `${title} on ${when} cancelled${by === 'invitee' ? ' by the customer' : ''}`,
  ),
  'appointment.status_changed': statusChanged,
};
