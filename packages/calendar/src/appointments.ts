// Appointment queries and lifecycle changes that need no availability check.
import { displayName, eventMeta, type CrmContext } from '@businessos/crm';
import {
  appointmentParticipants,
  appointments,
  appointmentTypes,
  calendarBusyBlocks,
  calendars,
  crmContacts,
  type Appointment,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import { ConflictError, decodeCursor, encodeCursor, NotFoundError } from '@businessos/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

export interface AppointmentSummary {
  id: string;
  title: string;
  status: Appointment['status'];
  source: Appointment['source'];
  startsAt: string;
  endsAt: string;
  timezone: string;
  appointmentType: { id: string; name: string } | null;
  calendar: { id: string; name: string };
  hosts: { calendarId: string; name: string; userId: string | null }[];
  contact: { id: string; name: string } | null;
  invitee: { name: string | null; email: string | null; phone: string | null };
  notes: string | null;
  locationKind: Appointment['locationKind'];
  locationDetails: string | null;
  joinUrl: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}

async function summaries(
  tx: TenantTx,
  ctx: CrmContext,
  rows: Appointment[],
): Promise<AppointmentSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const hostRows = await tx
    .select({
      appointmentId: appointmentParticipants.appointmentId,
      calendarId: calendars.id,
      name: calendars.name,
      userId: calendars.userId,
    })
    .from(appointmentParticipants)
    .innerJoin(calendars, eq(calendars.id, appointmentParticipants.calendarId))
    .where(
      and(
        inArray(appointmentParticipants.appointmentId, ids),
        eq(appointmentParticipants.role, 'host'),
      ),
    );
  const typeRows = await tx
    .select({ id: appointmentTypes.id, name: appointmentTypes.name })
    .from(appointmentTypes)
    .where(
      inArray(
        appointmentTypes.id,
        rows.flatMap((row) => (row.appointmentTypeId ? [row.appointmentTypeId] : [])),
      ),
    );
  // Contact names only for members who can read contacts.
  const contactRows =
    (ctx.canRead?.contact ?? true)
      ? await tx
          .select()
          .from(crmContacts)
          .where(
            and(
              inArray(
                crmContacts.id,
                rows.flatMap((row) => (row.contactId ? [row.contactId] : [])),
              ),
              isNull(crmContacts.deletedAt),
            ),
          )
      : [];
  return rows.map((row) => {
    const hosts = hostRows
      .filter((host) => host.appointmentId === row.id)
      .map(({ calendarId, name, userId }) => ({ calendarId, name, userId }));
    const primary = hosts.find((host) => host.calendarId === row.calendarId);
    const type = typeRows.find((entry) => entry.id === row.appointmentTypeId);
    const contact = contactRows.find((entry) => entry.id === row.contactId);
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      source: row.source,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timezone: row.timezone,
      appointmentType: type ? { id: type.id, name: type.name } : null,
      calendar: { id: row.calendarId, name: primary?.name ?? '—' },
      hosts,
      contact: contact ? { id: contact.id, name: displayName(contact) } : null,
      invitee: { name: row.inviteeName, email: row.inviteeEmail, phone: row.inviteePhone },
      notes: row.inviteeNotes,
      locationKind: row.locationKind,
      locationDetails: row.locationDetails,
      joinUrl: row.joinUrl,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancellationReason: row.cancellationReason,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function getAppointmentRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<Appointment> {
  const query = tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.organizationId, organizationId)));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Appointment');
  return row;
}

export async function getAppointment(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<AppointmentSummary> {
  const [summary] = await summaries(tx, ctx, [await getAppointmentRow(tx, ctx.organizationId, id)]);
  if (!summary) throw new NotFoundError('Appointment');
  return summary;
}

export const appointmentListQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  calendarId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  status: z.enum(['scheduled', 'cancelled', 'completed', 'no_show', 'all']).default('scheduled'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const cursorSchema = z.object({ t: z.string().max(40), id: z.uuid() });

/** Appointments ordered by start time (keyset paged), optionally within a window. */
export async function listAppointments(
  tx: TenantTx,
  ctx: CrmContext,
  rawQuery: z.input<typeof appointmentListQuerySchema>,
): Promise<{ data: AppointmentSummary[]; nextCursor: string | null }> {
  const query = appointmentListQuerySchema.parse(rawQuery);
  const conditions: SQL[] = [eq(appointments.organizationId, ctx.organizationId)];
  if (query.status !== 'all') conditions.push(eq(appointments.status, query.status));
  if (query.from) conditions.push(gte(appointments.endsAt, new Date(query.from)));
  if (query.to) conditions.push(lt(appointments.startsAt, new Date(query.to)));
  if (query.contactId) conditions.push(eq(appointments.contactId, query.contactId));
  if (query.calendarId) {
    conditions.push(
      sql`exists (select 1 from ${appointmentParticipants} where ${appointmentParticipants.appointmentId} = ${appointments.id} and ${appointmentParticipants.calendarId} = ${query.calendarId})`,
    );
  }
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    const after = or(
      gt(appointments.startsAt, new Date(position.t)),
      and(eq(appointments.startsAt, new Date(position.t)), gt(appointments.id, position.id)),
    );
    if (after) conditions.push(after);
  }
  const rows = await tx
    .select()
    .from(appointments)
    .where(and(...conditions))
    .orderBy(asc(appointments.startsAt), asc(appointments.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: await summaries(tx, ctx, page),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ t: last.startsAt.toISOString(), id: last.id })
        : null,
  };
}

export const cancelInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Cancels a scheduled appointment and frees its time on every host calendar. */
export async function cancelAppointment(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof cancelInputSchema>,
  by: 'invitee' | 'staff',
): Promise<Appointment> {
  const input = cancelInputSchema.parse(rawInput);
  const current = await getAppointmentRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status !== 'scheduled') {
    throw new ConflictError('Only scheduled appointments can be cancelled');
  }
  const [cancelled] = await tx
    .update(appointments)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: by,
      cancellationReason: input.reason ?? null,
    })
    .where(and(eq(appointments.id, id), eq(appointments.organizationId, ctx.organizationId)))
    .returning();
  if (!cancelled) throw new NotFoundError('Appointment');
  await tx.delete(calendarBusyBlocks).where(eq(calendarBusyBlocks.appointmentId, id));
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'appointment.cancelled',
    subject: { type: 'appointment', id },
    payload: {
      appointmentId: id,
      contactId: cancelled.contactId,
      startsAt: cancelled.startsAt.toISOString(),
      by,
    },
  });
  return cancelled;
}

export const statusInputSchema = z.object({
  status: z.enum(['completed', 'no_show']),
});

/** Marks a started appointment as completed or a no-show. */
export async function setAppointmentStatus(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof statusInputSchema>,
  now = Date.now(),
): Promise<AppointmentSummary> {
  const { status } = statusInputSchema.parse(rawInput);
  const current = await getAppointmentRow(tx, ctx.organizationId, id, { lock: true });
  if (current.status === 'cancelled') throw new ConflictError('This appointment was cancelled');
  if (current.startsAt.getTime() > now) {
    throw new ConflictError('An appointment can be marked only after it has started');
  }
  if (current.status !== status) {
    await tx
      .update(appointments)
      .set({ status })
      .where(and(eq(appointments.id, id), eq(appointments.organizationId, ctx.organizationId)));
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'appointment.status_changed',
      subject: { type: 'appointment', id },
      payload: {
        appointmentId: id,
        contactId: current.contactId,
        from: current.status,
        to: status,
      },
    });
  }
  return getAppointment(tx, ctx, id);
}
