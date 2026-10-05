// Booking and rescheduling: availability, host assignment and the double-booking guard.
import { createContact, eventMeta, normalizeEmail, type CrmContext } from '@businessos/crm';
import {
  appointmentParticipants,
  appointments,
  appointmentTypes,
  bookingPageTypes,
  calendarBusyBlocks,
  calendars,
  crmContacts,
  pgErrorInfo,
  PG_ERROR,
  withTenant,
  type Appointment,
  type AppointmentType,
  type Database,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  ConflictError,
  EntitlementExceededError,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getCalendarRow } from './calendars';
import { externalBusyTimes, resolveConnections, type CalendarServices } from './connections';
import { rankRoundRobinHosts, type HostLoad } from './scheduling';
import { computeSlots, loadSchedulingData } from './slots';
import { DAY_MS, isValidTimeZone, minutes } from './time';
import { getAppointment, getAppointmentRow, type AppointmentSummary } from './appointments';
import { createManageToken } from './manage-links';
import { initialReminderState } from './reminders';

const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine(isValidTimeZone, { message: 'Unknown time zone' });

export const inviteeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2_000).optional(),
  timezone: timeZoneSchema,
});
export type InviteeInput = z.input<typeof inviteeSchema>;

export const publicBookingInputSchema = z.object({
  appointmentTypeId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  invitee: inviteeSchema,
});

export const staffAppointmentInputSchema = z
  .object({
    appointmentTypeId: z.uuid().optional(),
    /** Host calendar (required without a type; with a type, one of its hosts). */
    calendarId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    startsAt: z.iso.datetime({ offset: true }),
    /** Without a type. */
    durationMinutes: z.number().int().min(5).max(720).optional(),
    contactId: z.uuid().nullable().optional(),
    invitee: inviteeSchema.partial({ name: true, email: true, timezone: true }).optional(),
    locationKind: z.enum(['in_person', 'phone', 'video', 'custom']).optional(),
    locationDetails: z.string().trim().max(500).nullable().optional(),
    /** Book outside working hours/notice rules (double booking stays impossible). */
    ignoreAvailability: z.boolean().default(false),
  })
  .refine((input) => input.appointmentTypeId !== undefined || input.calendarId !== undefined, {
    message: 'Choose a calendar or an appointment type',
    path: ['calendarId'],
  })
  .refine(
    (input) =>
      input.appointmentTypeId !== undefined ||
      (input.durationMinutes !== undefined && input.title !== undefined),
    { message: 'Give a title and duration', path: ['durationMinutes'] },
  );

function isExclusionViolation(error: unknown): boolean {
  return pgErrorInfo(error)?.code === PG_ERROR.exclusionViolation;
}

/** Finds the invitee's contact by email or creates one; booking never fails because of the CRM. */
async function resolveInviteeContact(
  tx: TenantTx,
  ctx: CrmContext,
  invitee: { name: string; email: string; phone?: string | undefined },
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.organizationId, ctx.organizationId),
        eq(crmContacts.email, invitee.email),
        isNull(crmContacts.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [first, ...rest] = invitee.name.split(/\s+/).filter(Boolean);
  const base = {
    firstName: first ?? null,
    lastName: rest.length > 0 ? rest.join(' ') : null,
    email: invitee.email,
    source: 'booking',
    ownerUserId: null,
  };
  for (const attempt of invitee.phone ? [{ ...base, phone: invitee.phone }, base] : [base]) {
    try {
      const created = await tx.transaction((sp) => createContact(sp as TenantTx, ctx, attempt));
      return created.id;
    } catch (error) {
      if (error instanceof ValidationError) continue; // e.g. an unusable phone number
      if (error instanceof EntitlementExceededError || error instanceof ConflictError) return null;
      throw error;
    }
  }
  return null;
}

/** Load per host for round robin: upcoming bookings of this type and the latest booking. */
async function hostLoads(
  tx: TenantTx,
  organizationId: string,
  typeId: string,
  calendarIds: readonly string[],
  now: number,
): Promise<Map<string, HostLoad>> {
  if (calendarIds.length === 0) return new Map();
  const rows = await tx
    .select({
      calendarId: appointments.calendarId,
      upcoming: sql<number>`count(*) filter (where ${appointments.status} = 'scheduled' and ${appointments.startsAt} >= ${new Date(now)})::int`,
      lastBookedAt: sql<string | null>`max(${appointments.createdAt})::text`,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, organizationId),
        eq(appointments.appointmentTypeId, typeId),
        inArray(appointments.calendarId, [...calendarIds]),
      ),
    )
    .groupBy(appointments.calendarId);
  return new Map(
    rows.map((row) => [
      row.calendarId,
      {
        upcoming: row.upcoming,
        lastBookedAt: row.lastBookedAt ? Date.parse(row.lastBookedAt) : null,
      },
    ]),
  );
}

interface Placement {
  start: number;
  end: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

/**
 * Holds `[start − buffer, end + buffer)` on every host calendar. The exclusion constraint
 * rejects any overlap with an existing booking, including one committed a moment ago by a
 * concurrent request.
 */
async function holdTime(
  tx: TenantTx,
  organizationId: string,
  appointmentId: string,
  calendarIds: readonly string[],
  placement: Placement,
): Promise<void> {
  await tx.insert(calendarBusyBlocks).values(
    calendarIds.map((calendarId) => ({
      organizationId,
      calendarId,
      appointmentId,
      startsAt: new Date(placement.start - minutes(placement.bufferBeforeMinutes)),
      endsAt: new Date(placement.end + minutes(placement.bufferAfterMinutes)),
    })),
  );
}

interface NewAppointment {
  type: AppointmentType | null;
  title: string;
  placement: Placement;
  /** Booking time (decides whether a reminder is still needed). */
  now: number;
  /** Host sets to try in order (round robin: one per free host). */
  candidates: string[][];
  source: Appointment['source'];
  bookingPageId: string | null;
  contactId: string | null;
  invitee: {
    name: string | null;
    email: string | null;
    phone: string | null;
    notes: string | null;
    timezone: string;
  };
  locationKind: Appointment['locationKind'];
  locationDetails: string | null;
}

async function insertAppointment(
  tx: TenantTx,
  ctx: CrmContext,
  input: NewAppointment,
): Promise<{ appointment: Appointment; calendarIds: string[] }> {
  for (const hostSet of input.candidates) {
    const primary = hostSet[0];
    if (!primary) continue;
    try {
      return await tx.transaction(async (sp) => {
        const savepoint = sp as TenantTx;
        const [appointment] = await savepoint
          .insert(appointments)
          .values({
            organizationId: ctx.organizationId,
            appointmentTypeId: input.type?.id ?? null,
            calendarId: primary,
            contactId: input.contactId,
            bookingPageId: input.bookingPageId,
            title: input.title,
            startsAt: new Date(input.placement.start),
            endsAt: new Date(input.placement.end),
            bufferBeforeMinutes: input.placement.bufferBeforeMinutes,
            bufferAfterMinutes: input.placement.bufferAfterMinutes,
            source: input.source,
            locationKind: input.locationKind,
            locationDetails: input.locationDetails,
            timezone: input.invitee.timezone,
            inviteeName: input.invitee.name,
            inviteeEmail: input.invitee.email,
            inviteePhone: input.invitee.phone,
            inviteeNotes: input.invitee.notes,
            createdByUserId: ctx.actor.userId,
            reminderSentAt: initialReminderState(input.placement.start, input.now),
          })
          .returning();
        if (!appointment) throw new Error('appointment insert returned no row');
        await holdTime(savepoint, ctx.organizationId, appointment.id, hostSet, input.placement);
        const hostCalendars = await savepoint
          .select({ id: calendars.id, userId: calendars.userId })
          .from(calendars)
          .where(inArray(calendars.id, hostSet));
        await savepoint.insert(appointmentParticipants).values([
          ...hostSet.map((calendarId) => ({
            organizationId: ctx.organizationId,
            appointmentId: appointment.id,
            role: 'host' as const,
            calendarId,
            userId: hostCalendars.find((row) => row.id === calendarId)?.userId ?? null,
          })),
          ...(input.invitee.email || input.contactId
            ? [
                {
                  organizationId: ctx.organizationId,
                  appointmentId: appointment.id,
                  role: 'invitee' as const,
                  contactId: input.contactId,
                  name: input.invitee.name,
                  email: input.invitee.email,
                },
              ]
            : []),
        ]);
        return { appointment, calendarIds: hostSet };
      });
    } catch (error) {
      if (isExclusionViolation(error)) continue;
      throw error;
    }
  }
  throw new ConflictError('This time is no longer available. Please choose another time.');
}

async function emitBooked(
  tx: TenantTx,
  ctx: CrmContext,
  appointment: Appointment,
  calendarIds: string[],
) {
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'appointment.booked',
    subject: { type: 'appointment', id: appointment.id },
    payload: {
      appointmentId: appointment.id,
      appointmentTypeId: appointment.appointmentTypeId,
      calendarIds,
      contactId: appointment.contactId,
      startsAt: appointment.startsAt.toISOString(),
      source: appointment.source,
    },
  });
}

/** Normalized invitee email; invalid addresses are a validation error on `invitee.email`. */
function inviteeEmail(raw: string): string {
  return normalizeEmail(raw, 'invitee.email');
}

/** Free hosts for one start, ordered for assignment (round robin by load). */
async function candidatesAt(
  tx: TenantTx,
  services: CalendarServices,
  ctx: CrmContext,
  type: AppointmentType,
  start: number,
  now: number,
  options: { excludeAppointmentId?: string; preferCalendarId?: string } = {},
): Promise<string[][]> {
  const range = { start: start - DAY_MS, end: start + DAY_MS };
  const data = await loadSchedulingData(tx, ctx.organizationId, type.id, range, {
    ...(options.excludeAppointmentId ? { excludeAppointmentId: options.excludeAppointmentId } : {}),
  });
  const connections = await resolveConnections(
    tx,
    ctx.organizationId,
    services,
    data.hosts.map((host) => host.calendarId),
    'conflicts',
  );
  const external = await externalBusyTimes(services, connections, range);
  const slot = computeSlots(data, external, { start, end: start + 1 }, now).find(
    (entry) => entry.start === start,
  );
  if (!slot) {
    throw new ConflictError('This time is no longer available. Please choose another time.');
  }
  if (type.schedulingMode === 'collective') return [slot.calendarIds];
  if (type.schedulingMode === 'individual') return [slot.calendarIds.slice(0, 1)];
  const ranked = rankRoundRobinHosts(
    slot.calendarIds,
    await hostLoads(tx, ctx.organizationId, type.id, slot.calendarIds, now),
  );
  const preferred = options.preferCalendarId;
  const ordered =
    preferred && ranked.includes(preferred)
      ? [preferred, ...ranked.filter((id) => id !== preferred)]
      : ranked;
  return ordered.map((calendarId) => [calendarId]);
}

export interface BookingResult {
  appointment: AppointmentSummary;
  /** Plain manage-link token for the invitee's confirmation email (null without an invitee). */
  manageToken: string | null;
}

/**
 * Public booking through a booking page. The requested start must be one of the type's
 * currently available slots; the busy-block exclusion constraint settles races between
 * concurrent bookings (round robin falls through to the next free host).
 */
export async function bookFromPage(
  db: Database,
  services: CalendarServices,
  target: {
    organizationId: string;
    bookingPageId: string;
    countryCode: string;
    defaultCurrency: string;
    timezone: string;
  },
  rawInput: z.input<typeof publicBookingInputSchema>,
  now = Date.now(),
): Promise<BookingResult> {
  const input = publicBookingInputSchema.parse(rawInput);
  const email = inviteeEmail(input.invitee.email);
  const start = Date.parse(input.startsAt);
  const ctx: CrmContext = {
    organizationId: target.organizationId,
    countryCode: target.countryCode,
    defaultCurrency: target.defaultCurrency,
    timezone: target.timezone,
    actor: { type: 'system', userId: null },
  };
  return withTenant(db, { organizationId: target.organizationId, userId: null }, async (tx) => {
    const [offered] = await tx
      .select({ type: appointmentTypes })
      .from(appointmentTypes)
      .innerJoin(
        bookingPageTypes,
        and(
          eq(bookingPageTypes.appointmentTypeId, appointmentTypes.id),
          eq(bookingPageTypes.bookingPageId, target.bookingPageId),
        ),
      )
      .where(
        and(
          eq(appointmentTypes.id, input.appointmentTypeId),
          eq(appointmentTypes.organizationId, target.organizationId),
          eq(appointmentTypes.isActive, true),
        ),
      );
    if (!offered) throw new NotFoundError('Appointment type');
    const type = offered.type;
    const candidates = await candidatesAt(tx, services, ctx, type, start, now);
    const contactId = await resolveInviteeContact(tx, ctx, {
      name: input.invitee.name,
      email,
      phone: input.invitee.phone,
    });
    const { appointment, calendarIds } = await insertAppointment(tx, ctx, {
      now,
      type,
      title: type.name,
      placement: {
        start,
        end: start + minutes(type.durationMinutes),
        bufferBeforeMinutes: type.bufferBeforeMinutes,
        bufferAfterMinutes: type.bufferAfterMinutes,
      },
      candidates,
      source: 'booking_page',
      bookingPageId: target.bookingPageId,
      contactId,
      invitee: {
        name: input.invitee.name,
        email,
        phone: input.invitee.phone ?? null,
        notes: input.invitee.notes ?? null,
        timezone: input.invitee.timezone,
      },
      locationKind: type.locationKind,
      locationDetails: type.locationDetails,
    });
    await emitBooked(tx, ctx, appointment, calendarIds);
    const manageToken = await createManageToken(tx, ctx.organizationId, appointment);
    return { appointment: await getAppointment(tx, ctx, appointment.id), manageToken };
  });
}

/** Staff booking from the app (permission `calendar.appointment.manage`, checked by the caller). */
export async function createStaffAppointment(
  db: Database,
  services: CalendarServices,
  ctx: CrmContext,
  rawInput: z.input<typeof staffAppointmentInputSchema>,
  now = Date.now(),
): Promise<BookingResult> {
  const input = staffAppointmentInputSchema.parse(rawInput);
  const start = Date.parse(input.startsAt);
  if (start < now - DAY_MS) {
    throw new ValidationError('Invalid time', [
      { path: 'startsAt', message: 'Appointments cannot start in the past' },
    ]);
  }
  return withTenant(
    db,
    { organizationId: ctx.organizationId, userId: ctx.actor.userId },
    async (tx) => {
      let type: AppointmentType | null = null;
      let candidates: string[][];
      if (input.appointmentTypeId) {
        const [row] = await tx
          .select()
          .from(appointmentTypes)
          .where(
            and(
              eq(appointmentTypes.id, input.appointmentTypeId),
              eq(appointmentTypes.organizationId, ctx.organizationId),
            ),
          );
        if (!row) throw new NotFoundError('Appointment type');
        type = row;
        if (input.ignoreAvailability) {
          const data = await loadSchedulingData(tx, ctx.organizationId, row.id, {
            start,
            end: start + 1,
          });
          const hosts = data.hosts.filter((host) => host.isActive).map((host) => host.calendarId);
          if (input.calendarId && !hosts.includes(input.calendarId)) {
            throw new ValidationError('Invalid host', [
              { path: 'calendarId', message: 'Not a host of this appointment type' },
            ]);
          }
          candidates =
            row.schedulingMode === 'collective'
              ? [hosts]
              : (input.calendarId ? [input.calendarId] : hosts).map((id) => [id]);
        } else {
          candidates = await candidatesAt(tx, services, ctx, row, start, now, {
            ...(input.calendarId ? { preferCalendarId: input.calendarId } : {}),
          });
          if (input.calendarId && row.schedulingMode !== 'collective') {
            candidates = candidates.filter((set) => set[0] === input.calendarId);
            if (candidates.length === 0) {
              throw new ConflictError('That host is not available at this time');
            }
          }
        }
      } else {
        const calendar = await getCalendarRow(tx, ctx.organizationId, input.calendarId ?? '');
        if (!calendar.isActive) throw new ConflictError('This calendar is inactive');
        candidates = [[calendar.id]];
      }
      let contactId: string | null = null;
      if (input.contactId) {
        const [contact] = await tx
          .select({ id: crmContacts.id, email: crmContacts.email })
          .from(crmContacts)
          .where(
            and(
              eq(crmContacts.id, input.contactId),
              eq(crmContacts.organizationId, ctx.organizationId),
              isNull(crmContacts.deletedAt),
            ),
          );
        if (!contact) {
          throw new ValidationError('Invalid contact', [
            { path: 'contactId', message: 'Not found' },
          ]);
        }
        contactId = contact.id;
      }
      const email = input.invitee?.email ? inviteeEmail(input.invitee.email) : null;
      const duration = type?.durationMinutes ?? input.durationMinutes ?? 30;
      const { appointment, calendarIds } = await insertAppointment(tx, ctx, {
        now,
        type,
        title: input.title ?? type?.name ?? 'Appointment',
        placement: {
          start,
          end: start + minutes(duration),
          bufferBeforeMinutes: type?.bufferBeforeMinutes ?? 0,
          bufferAfterMinutes: type?.bufferAfterMinutes ?? 0,
        },
        candidates,
        source: 'staff',
        bookingPageId: null,
        contactId,
        invitee: {
          name: input.invitee?.name ?? null,
          email,
          phone: input.invitee?.phone ?? null,
          notes: input.invitee?.notes ?? null,
          timezone: input.invitee?.timezone ?? ctx.timezone,
        },
        locationKind: input.locationKind ?? type?.locationKind ?? 'in_person',
        locationDetails: input.locationDetails ?? type?.locationDetails ?? null,
      });
      await emitBooked(tx, ctx, appointment, calendarIds);
      const manageToken = email
        ? await createManageToken(tx, ctx.organizationId, appointment)
        : null;
      return { appointment: await getAppointment(tx, ctx, appointment.id), manageToken };
    },
  );
}

export const rescheduleInputSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  ignoreAvailability: z.boolean().default(false),
});

/**
 * Moves a scheduled appointment in place. The new time is validated like a new booking (its
 * own current time does not count as busy); the old hold is replaced inside a savepoint, so a
 * conflict leaves the appointment untouched.
 */
export async function rescheduleAppointment(
  db: Database,
  services: CalendarServices,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof rescheduleInputSchema>,
  by: 'invitee' | 'staff',
  now = Date.now(),
): Promise<AppointmentSummary> {
  const input = rescheduleInputSchema.parse(rawInput);
  const start = Date.parse(input.startsAt);
  if (start <= now) {
    throw new ValidationError('Invalid time', [
      { path: 'startsAt', message: 'Choose a time in the future' },
    ]);
  }
  return withTenant(
    db,
    { organizationId: ctx.organizationId, userId: ctx.actor.userId },
    async (tx) => {
      const current = await getAppointmentRow(tx, ctx.organizationId, id, { lock: true });
      if (current.status !== 'scheduled') {
        throw new ConflictError('Only scheduled appointments can be rescheduled');
      }
      const duration = current.endsAt.getTime() - current.startsAt.getTime();
      const placement: Placement = {
        start,
        end: start + duration,
        bufferBeforeMinutes: current.bufferBeforeMinutes,
        bufferAfterMinutes: current.bufferAfterMinutes,
      };
      const currentHosts = (
        await tx
          .select({ calendarId: calendarBusyBlocks.calendarId })
          .from(calendarBusyBlocks)
          .where(eq(calendarBusyBlocks.appointmentId, id))
      ).map((row) => row.calendarId);
      let candidates: string[][] = [currentHosts.length > 0 ? currentHosts : [current.calendarId]];
      if (current.appointmentTypeId && !(by === 'staff' && input.ignoreAvailability)) {
        const [type] = await tx
          .select()
          .from(appointmentTypes)
          .where(eq(appointmentTypes.id, current.appointmentTypeId));
        if (!type) throw new NotFoundError('Appointment type');
        candidates = await candidatesAt(tx, services, ctx, type, start, now, {
          excludeAppointmentId: id,
          preferCalendarId: current.calendarId,
        });
      }
      for (const hostSet of candidates) {
        const primary = hostSet[0];
        if (!primary) continue;
        try {
          await tx.transaction(async (sp) => {
            const savepoint = sp as TenantTx;
            await savepoint
              .delete(calendarBusyBlocks)
              .where(eq(calendarBusyBlocks.appointmentId, id));
            await holdTime(savepoint, ctx.organizationId, id, hostSet, placement);
            await savepoint
              .update(appointments)
              .set({
                startsAt: new Date(placement.start),
                endsAt: new Date(placement.end),
                calendarId: primary,
                reminderSentAt: initialReminderState(placement.start, now),
              })
              .where(
                and(eq(appointments.id, id), eq(appointments.organizationId, ctx.organizationId)),
              );
            if (hostSet.join() !== currentHosts.join()) {
              await savepoint
                .delete(appointmentParticipants)
                .where(
                  and(
                    eq(appointmentParticipants.appointmentId, id),
                    eq(appointmentParticipants.role, 'host'),
                  ),
                );
              const hostCalendars = await savepoint
                .select({ id: calendars.id, userId: calendars.userId })
                .from(calendars)
                .where(inArray(calendars.id, hostSet));
              await savepoint.insert(appointmentParticipants).values(
                hostSet.map((calendarId) => ({
                  organizationId: ctx.organizationId,
                  appointmentId: id,
                  role: 'host' as const,
                  calendarId,
                  userId: hostCalendars.find((row) => row.id === calendarId)?.userId ?? null,
                })),
              );
            }
          });
          await emitEvent(tx, {
            ...eventMeta(ctx),
            type: 'appointment.rescheduled',
            subject: { type: 'appointment', id },
            payload: {
              appointmentId: id,
              contactId: current.contactId,
              startsAt: new Date(start).toISOString(),
              previousStartsAt: current.startsAt.toISOString(),
              by,
            },
          });
          return await getAppointment(tx, ctx, id);
        } catch (error) {
          if (isExclusionViolation(error)) continue;
          throw error;
        }
      }
      throw new ConflictError('This time is no longer available. Please choose another time.');
    },
  );
}
