import {
  appointmentExternalEvents,
  appointmentParticipants,
  appointments,
  calendarConnections,
  withTenant,
  type Database,
} from '@businessos/database';
import { and, eq } from 'drizzle-orm';
import { resolveConnections, withAccessToken, type CalendarServices } from './connections';
import { CalendarProviderError } from './providers/types';

export interface SyncOutcome {
  created: number;
  cancelled: number;
  failed: number;
}

/**
 * Mirrors one appointment to its hosts' connected calendars (job `calendar.sync`). Scheduled
 * appointments get an event (recreated after a reschedule); cancelled ones lose it. Provider
 * calls run outside any transaction; each result is recorded per connection, so a retry only
 * redoes what is missing. Retryable provider failures are rethrown for the job to retry.
 */
export async function syncAppointmentEvents(
  db: Database,
  services: CalendarServices,
  organizationId: string,
  appointmentId: string,
): Promise<SyncOutcome> {
  const scope = { organizationId, userId: null };
  const loaded = await withTenant(db, scope, async (tx) => {
    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(
        and(eq(appointments.id, appointmentId), eq(appointments.organizationId, organizationId)),
      );
    if (!appointment) return null;
    const hosts = await tx
      .select({ calendarId: appointmentParticipants.calendarId })
      .from(appointmentParticipants)
      .where(
        and(
          eq(appointmentParticipants.appointmentId, appointmentId),
          eq(appointmentParticipants.role, 'host'),
        ),
      );
    const calendarIds = hosts.flatMap((host) => (host.calendarId ? [host.calendarId] : []));
    const connections = await resolveConnections(
      tx,
      organizationId,
      services,
      calendarIds,
      'events',
    );
    const existing = await tx
      .select()
      .from(appointmentExternalEvents)
      .where(eq(appointmentExternalEvents.appointmentId, appointmentId));
    return { appointment, connections, existing };
  });
  const outcome: SyncOutcome = { created: 0, cancelled: 0, failed: 0 };
  if (!loaded) return outcome;
  const { appointment, connections, existing } = loaded;
  const active = appointment.status === 'scheduled';
  let retryable: unknown = null;
  let joinUrl: string | null = null;

  for (const connection of connections) {
    const provider = services.providers.get(connection.provider);
    if (!provider) continue;
    const record = existing.find((row) => row.connectionId === connection.id);
    const current =
      record?.status === 'created' && record.externalEventId ? record.externalEventId : null;
    const upToDate = record?.syncedStartsAt?.getTime() === appointment.startsAt.getTime();
    let removed = false;
    try {
      const authorized = await withAccessToken(services, connection);
      if (current && (!active || !upToDate)) {
        await provider.cancelEvent(authorized, current);
        removed = true;
        outcome.cancelled += 1;
      }
      let created: { externalEventId: string; joinUrl: string | null } | null = null;
      if (active && !(current && upToDate)) {
        created = await provider.createEvent(authorized, {
          appointmentId: appointment.id,
          title: appointment.title,
          description: [appointment.inviteeName, appointment.inviteeNotes]
            .filter(Boolean)
            .join('\n'),
          start: appointment.startsAt.getTime(),
          end: appointment.endsAt.getTime(),
          timeZone: appointment.timezone,
          attendees: appointment.inviteeEmail
            ? [{ email: appointment.inviteeEmail, name: appointment.inviteeName }]
            : [],
          addVideoMeeting: appointment.locationKind === 'video' && !appointment.joinUrl,
        });
        outcome.created += 1;
        joinUrl ??= created.joinUrl;
      }
      if (!current && !created) continue;
      await withTenant(db, scope, async (tx) => {
        const values = created
          ? {
              externalEventId: created.externalEventId,
              syncedStartsAt: appointment.startsAt,
              status: 'created',
              lastError: null,
            }
          : { status: 'cancelled', lastError: null };
        await tx
          .insert(appointmentExternalEvents)
          .values({ organizationId, appointmentId, connectionId: connection.id, ...values })
          .onConflictDoUpdate({
            target: [
              appointmentExternalEvents.appointmentId,
              appointmentExternalEvents.connectionId,
            ],
            set: values,
          });
        await tx
          .update(calendarConnections)
          .set({ lastSyncedAt: new Date(), lastError: null })
          .where(eq(calendarConnections.id, connection.id));
      });
    } catch (error) {
      outcome.failed += 1;
      const message =
        error instanceof CalendarProviderError ? error.message : 'Calendar provider request failed';
      await withTenant(db, scope, async (tx) => {
        await tx
          .insert(appointmentExternalEvents)
          .values({
            organizationId,
            appointmentId,
            connectionId: connection.id,
            status: 'failed',
            lastError: message,
          })
          .onConflictDoUpdate({
            target: [
              appointmentExternalEvents.appointmentId,
              appointmentExternalEvents.connectionId,
            ],
            // Keep pointing at a live event; otherwise the next run starts from scratch.
            set: { lastError: message, ...(current && !removed ? {} : { status: 'failed' }) },
          });
        await tx
          .update(calendarConnections)
          .set({ lastError: message })
          .where(eq(calendarConnections.id, connection.id));
      });
      if (!(error instanceof CalendarProviderError) || error.retryable) retryable ??= error;
    }
  }
  if (joinUrl) {
    await withTenant(db, scope, (tx) =>
      tx
        .update(appointments)
        .set({ joinUrl })
        .where(and(eq(appointments.id, appointmentId), eq(appointments.status, 'scheduled'))),
    );
  }
  if (retryable) throw retryable instanceof Error ? retryable : new Error('Calendar sync failed');
  return outcome;
}
