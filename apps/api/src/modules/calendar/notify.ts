import {
  createManageToken,
  formatAppointmentTime,
  getAppointmentRow,
  locationText,
  manageUrl,
  type AppointmentSummary,
} from '@businessos/calendar';
import { withTenant } from '@businessos/database';
import type { FastifyInstance } from 'fastify';

type Template = 'appointment_confirmed' | 'appointment_rescheduled' | 'appointment_cancelled';

/**
 * Emails the invitee about their appointment through the `email.send` job (after the change
 * committed). Deterministic job ids make a retried request harmless.
 */
export async function notifyInvitee(
  app: FastifyInstance,
  input: {
    appointment: AppointmentSummary;
    organizationName: string;
    template: Template;
    manageToken: string | null;
    correlationId: string;
  },
): Promise<void> {
  const { appointment } = input;
  const to = appointment.invitee.email;
  if (!to) return;
  const link = input.manageToken ? manageUrl(app.deps.env.APP_URL, input.manageToken) : null;
  await app.deps.jobs.enqueue(
    'email.send',
    {
      template: input.template,
      to,
      locale: 'en',
      data: {
        organization: input.organizationName,
        name: appointment.invitee.name ?? '',
        title: appointment.title,
        when: formatAppointmentTime(new Date(appointment.startsAt), appointment.timezone),
        location: locationText(appointment),
        manageUrl: link,
      },
    },
    {
      jobId: `${input.template}-${appointment.id}-${Date.parse(appointment.startsAt)}`,
      correlationId: input.correlationId,
    },
  );
}

/** Mirrors the appointment's current state to connected external calendars. */
export async function queueCalendarSync(
  app: FastifyInstance,
  organizationId: string,
  appointment: AppointmentSummary,
  correlationId: string,
): Promise<void> {
  await app.deps.jobs.enqueue(
    'calendar.sync',
    { organizationId, appointmentId: appointment.id },
    {
      jobId: `cal-sync-${appointment.id}-${appointment.status}-${Date.parse(appointment.startsAt)}`,
      correlationId,
      organizationId,
    },
  );
}

/** A fresh manage-link token for the invitee (e.g. after a staff reschedule). */
export function issueManageLink(
  app: FastifyInstance,
  organizationId: string,
  appointmentId: string,
): Promise<string> {
  return withTenant(app.deps.db.db, { organizationId, userId: null }, async (tx) =>
    createManageToken(
      tx,
      organizationId,
      await getAppointmentRow(tx, organizationId, appointmentId),
    ),
  );
}
