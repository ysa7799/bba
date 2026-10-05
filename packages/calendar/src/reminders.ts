import {
  appointments,
  organizations,
  withSystem,
  withTenant,
  type Appointment,
  type Database,
} from '@businessos/database';
import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { createManageToken } from './manage-links';
import { DAY_MS } from './time';
import { formatAppointmentTime } from './timeline';

/** Reminders go out up to this long before the start… */
export const REMINDER_LEAD_MS = DAY_MS;
/** …unless the booking (or reschedule) happened less than this before the start: its
 * confirmation is recent enough, so the reminder is marked handled right away. */
export const REMINDER_MIN_NOTICE_MS = 12 * 3_600_000;

/** Initial `reminder_sent_at` for an appointment booked or moved to `start` at `now`. */
export function initialReminderState(start: number, now: number): Date | null {
  return start - now < REMINDER_MIN_NOTICE_MS ? new Date(now) : null;
}

export interface AppointmentEmail {
  to: string;
  data: {
    organization: string;
    name: string;
    title: string;
    when: string;
    location: string;
    manageUrl: string | null;
  };
}

export function locationText(
  appointment: Pick<Appointment, 'locationKind' | 'locationDetails' | 'joinUrl'>,
): string {
  if (appointment.joinUrl) return appointment.joinUrl;
  if (appointment.locationDetails) return appointment.locationDetails;
  switch (appointment.locationKind) {
    case 'phone':
      return 'Phone call';
    case 'video':
      return 'Video call (link to follow)';
    case 'in_person':
      return 'In person';
    case 'custom':
      return 'See details from the organizer';
  }
}

/** Email content for an appointment message to the invitee (no staff-only data). */
export function appointmentEmail(
  appointment: Appointment,
  organizationName: string,
  manageUrl: string | null,
): AppointmentEmail | null {
  if (!appointment.inviteeEmail) return null;
  return {
    to: appointment.inviteeEmail,
    data: {
      organization: organizationName,
      name: appointment.inviteeName ?? '',
      title: appointment.title,
      when: formatAppointmentTime(appointment.startsAt, appointment.timezone),
      location: locationText(appointment),
      manageUrl,
    },
  };
}

export const manageUrl = (appUrl: string, token: string) =>
  `${appUrl.replace(/\/$/, '')}/book/manage/${token}`;

/**
 * Sends due invitee reminders. Each appointment is claimed (`reminder_sent_at`) in its tenant
 * before sending, so overlapping runs never send twice; a failed send releases the claim for
 * the next run. Returns counts; throws only if every attempt failed (the job then retries).
 */
export async function processDueReminders(
  db: Database,
  options: {
    now: number;
    appUrl: string;
    send: (email: AppointmentEmail) => Promise<void>;
    limit?: number;
  },
): Promise<{ sent: number; failed: number }> {
  const now = new Date(options.now);
  // System scope: a scheduled job looks for due reminders across tenants; each one is then
  // claimed and read inside its own tenant.
  const due = await withSystem(db, (tx) =>
    tx
      .select({ id: appointments.id, organizationId: appointments.organizationId })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, 'scheduled'),
          isNull(appointments.reminderSentAt),
          isNotNull(appointments.inviteeEmail),
          gt(appointments.startsAt, now),
          lte(appointments.startsAt, new Date(options.now + REMINDER_LEAD_MS)),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(options.limit ?? 100),
  );
  let sent = 0;
  let failed = 0;
  for (const item of due) {
    const scope = { organizationId: item.organizationId, userId: null };
    const email = await withTenant(db, scope, async (tx) => {
      const [claimed] = await tx
        .update(appointments)
        .set({ reminderSentAt: now })
        .where(
          and(
            eq(appointments.id, item.id),
            eq(appointments.status, 'scheduled'),
            isNull(appointments.reminderSentAt),
          ),
        )
        .returning();
      if (!claimed) return null;
      const [organization] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, item.organizationId));
      const token = await createManageToken(tx, item.organizationId, claimed);
      return appointmentEmail(claimed, organization?.name ?? '', manageUrl(options.appUrl, token));
    });
    if (!email) continue;
    try {
      await options.send(email);
      sent += 1;
    } catch {
      failed += 1;
      await withTenant(db, scope, (tx) =>
        tx.update(appointments).set({ reminderSentAt: null }).where(eq(appointments.id, item.id)),
      );
    }
  }
  if (failed > 0 && sent === 0) throw new Error(`All ${failed} appointment reminders failed`);
  return { sent, failed };
}
