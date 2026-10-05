import { assertActiveMember, type CrmContext } from '@businessos/crm';
import {
  calendarAvailabilityExceptions,
  calendarAvailabilityRules,
  calendars,
  users,
  type Calendar,
  type TenantTx,
} from '@businessos/database';
import { NotFoundError, ValidationError } from '@businessos/shared';
import { and, asc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import type { DateException, WeeklyRule } from './availability';
import { isValidTimeZone } from './time';

const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine(isValidTimeZone, { message: 'Unknown time zone' });

/** Gulf states that keep a Sunday–Thursday working week (the UAE moved to Monday–Friday). */
const SUNDAY_WEEK_COUNTRIES = new Set(['BH', 'SA', 'KW', 'QA', 'OM']);

/** Default working hours for a new personal calendar: 09:00–17:00 on the local working week. */
export function defaultWeeklyRules(countryCode: string): WeeklyRule[] {
  const days = SUNDAY_WEEK_COUNTRIES.has(countryCode.toUpperCase())
    ? [0, 1, 2, 3, 4]
    : [1, 2, 3, 4, 5];
  return days.map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
}

export interface CalendarSummary {
  id: string;
  kind: Calendar['kind'];
  name: string;
  timezone: string;
  isActive: boolean;
  user: { id: string; name: string } | null;
}

function toSummary(row: Calendar, userName: string | null): CalendarSummary {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    timezone: row.timezone,
    isActive: row.isActive,
    user: row.userId ? { id: row.userId, name: userName ?? '—' } : null,
  };
}

export async function getCalendarRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<Calendar> {
  const [row] = await tx
    .select()
    .from(calendars)
    .where(and(eq(calendars.id, id), eq(calendars.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Calendar');
  return row;
}

export async function listCalendars(
  tx: TenantTx,
  organizationId: string,
): Promise<CalendarSummary[]> {
  const rows = await tx
    .select({ calendar: calendars, userName: users.name })
    .from(calendars)
    .leftJoin(users, eq(users.id, calendars.userId))
    .where(eq(calendars.organizationId, organizationId))
    .orderBy(asc(calendars.kind), asc(calendars.name), asc(calendars.id))
    .limit(500);
  return rows.map((row) => toSummary(row.calendar, row.userName));
}

export async function getCalendar(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<CalendarSummary> {
  const [row] = await tx
    .select({ calendar: calendars, userName: users.name })
    .from(calendars)
    .leftJoin(users, eq(users.id, calendars.userId))
    .where(and(eq(calendars.id, id), eq(calendars.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Calendar');
  return toSummary(row.calendar, row.userName);
}

/**
 * The member's personal calendar, created on first use with default working hours in the
 * organization's time zone. Safe under concurrency (unique per member).
 */
export async function ensureUserCalendar(
  tx: TenantTx,
  ctx: CrmContext,
  userId: string,
): Promise<CalendarSummary> {
  const find = () =>
    tx
      .select({ calendar: calendars, userName: users.name })
      .from(calendars)
      .leftJoin(users, eq(users.id, calendars.userId))
      .where(and(eq(calendars.organizationId, ctx.organizationId), eq(calendars.userId, userId)));
  const [existing] = await find();
  if (existing) return toSummary(existing.calendar, existing.userName);
  await assertActiveMember(tx, ctx.organizationId, userId, 'userId');
  const [member] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const inserted = await tx
    .insert(calendars)
    .values({
      organizationId: ctx.organizationId,
      kind: 'user',
      userId,
      name: member?.name ?? 'Calendar',
      timezone: ctx.timezone,
    })
    .onConflictDoNothing()
    .returning();
  const created = inserted[0];
  if (created) {
    await tx.insert(calendarAvailabilityRules).values(
      defaultWeeklyRules(ctx.countryCode).map((rule) => ({
        organizationId: ctx.organizationId,
        calendarId: created.id,
        ...rule,
      })),
    );
    return toSummary(created, member?.name ?? null);
  }
  const [raced] = await find();
  if (!raced) throw new NotFoundError('Calendar');
  return toSummary(raced.calendar, raced.userName);
}

export const createCalendarInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: timeZoneSchema.optional(),
});

/** A shared resource calendar (room, team, equipment). */
export async function createResourceCalendar(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createCalendarInputSchema>,
): Promise<CalendarSummary> {
  const input = createCalendarInputSchema.parse(rawInput);
  const [row] = await tx
    .insert(calendars)
    .values({
      organizationId: ctx.organizationId,
      kind: 'resource',
      name: input.name,
      timezone: input.timezone ?? ctx.timezone,
    })
    .returning();
  if (!row) throw new Error('calendar insert returned no row');
  await tx.insert(calendarAvailabilityRules).values(
    defaultWeeklyRules(ctx.countryCode).map((rule) => ({
      organizationId: ctx.organizationId,
      calendarId: row.id,
      ...rule,
    })),
  );
  return toSummary(row, null);
}

export const updateCalendarInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: timeZoneSchema.optional(),
  isActive: z.boolean().optional(),
});

export async function updateCalendar(
  tx: TenantTx,
  organizationId: string,
  id: string,
  rawInput: z.input<typeof updateCalendarInputSchema>,
): Promise<CalendarSummary> {
  const input = updateCalendarInputSchema.parse(rawInput);
  await getCalendarRow(tx, organizationId, id);
  if (Object.keys(input).length > 0) {
    await tx
      .update(calendars)
      .set(input)
      .where(and(eq(calendars.id, id), eq(calendars.organizationId, organizationId)));
  }
  return getCalendar(tx, organizationId, id);
}

const minuteSchema = z.number().int().min(0).max(1440);

export const weeklyRulesInputSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            startMinute: minuteSchema,
            endMinute: minuteSchema,
          })
          .refine((rule) => rule.startMinute < rule.endMinute, {
            message: 'End must be after start',
            path: ['endMinute'],
          }),
      )
      .max(70),
  })
  .superRefine((input, ctx) => {
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      const day = input.rules
        .filter((rule) => rule.weekday === weekday)
        .toSorted((a, b) => a.startMinute - b.startMinute);
      for (let index = 1; index < day.length; index += 1) {
        const previous = day[index - 1];
        const current = day[index];
        if (previous && current && current.startMinute < previous.endMinute) {
          ctx.addIssue({
            code: 'custom',
            message: 'Working hours overlap on the same day',
            path: ['rules'],
          });
          return;
        }
      }
    }
  });

export interface Availability {
  calendarId: string;
  timezone: string;
  rules: WeeklyRule[];
  exceptions: (DateException & { id: string; reason: string | null })[];
}

/** Weekly hours plus overrides from `fromDate` (local date) onwards. */
export async function getAvailability(
  tx: TenantTx,
  organizationId: string,
  calendarId: string,
  fromDate?: string,
): Promise<Availability> {
  const calendar = await getCalendarRow(tx, organizationId, calendarId);
  const rules = await tx
    .select({
      weekday: calendarAvailabilityRules.weekday,
      startMinute: calendarAvailabilityRules.startMinute,
      endMinute: calendarAvailabilityRules.endMinute,
    })
    .from(calendarAvailabilityRules)
    .where(eq(calendarAvailabilityRules.calendarId, calendarId))
    .orderBy(asc(calendarAvailabilityRules.weekday), asc(calendarAvailabilityRules.startMinute));
  const exceptions = await tx
    .select({
      id: calendarAvailabilityExceptions.id,
      date: calendarAvailabilityExceptions.date,
      kind: calendarAvailabilityExceptions.kind,
      startMinute: calendarAvailabilityExceptions.startMinute,
      endMinute: calendarAvailabilityExceptions.endMinute,
      reason: calendarAvailabilityExceptions.reason,
    })
    .from(calendarAvailabilityExceptions)
    .where(
      and(
        eq(calendarAvailabilityExceptions.calendarId, calendarId),
        fromDate ? gte(calendarAvailabilityExceptions.date, fromDate) : undefined,
      ),
    )
    .orderBy(asc(calendarAvailabilityExceptions.date))
    .limit(500);
  return { calendarId, timezone: calendar.timezone, rules, exceptions };
}

/** Replaces a calendar's weekly working hours. */
export async function setWeeklyRules(
  tx: TenantTx,
  organizationId: string,
  calendarId: string,
  rawInput: z.input<typeof weeklyRulesInputSchema>,
): Promise<Availability> {
  const { rules } = weeklyRulesInputSchema.parse(rawInput);
  await getCalendarRow(tx, organizationId, calendarId);
  await tx
    .delete(calendarAvailabilityRules)
    .where(eq(calendarAvailabilityRules.calendarId, calendarId));
  if (rules.length > 0) {
    await tx
      .insert(calendarAvailabilityRules)
      .values(rules.map((rule) => ({ organizationId, calendarId, ...rule })));
  }
  return getAvailability(tx, organizationId, calendarId);
}

export const exceptionInputSchema = z
  .object({
    date: z.iso.date(),
    kind: z.enum(['available', 'unavailable']),
    startMinute: minuteSchema.nullable().default(null),
    endMinute: minuteSchema.nullable().default(null),
    reason: z.string().trim().max(200).nullable().default(null),
  })
  .superRefine((input, ctx) => {
    const partial = (input.startMinute === null) !== (input.endMinute === null);
    if (partial) {
      ctx.addIssue({ code: 'custom', message: 'Give both times or neither', path: ['endMinute'] });
    }
    if (
      input.startMinute !== null &&
      input.endMinute !== null &&
      input.startMinute >= input.endMinute
    ) {
      ctx.addIssue({ code: 'custom', message: 'End must be after start', path: ['endMinute'] });
    }
    if (input.kind === 'available' && input.startMinute === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Custom hours need a start and end time',
        path: ['startMinute'],
      });
    }
  });

export async function addAvailabilityException(
  tx: TenantTx,
  organizationId: string,
  calendarId: string,
  rawInput: z.input<typeof exceptionInputSchema>,
): Promise<{ id: string }> {
  const input = exceptionInputSchema.parse(rawInput);
  await getCalendarRow(tx, organizationId, calendarId);
  const existing = await tx
    .select({ id: calendarAvailabilityExceptions.id })
    .from(calendarAvailabilityExceptions)
    .where(eq(calendarAvailabilityExceptions.calendarId, calendarId))
    .limit(501);
  if (existing.length >= 500) {
    throw new ValidationError('Too many date overrides', [
      { path: 'date', message: 'Remove past or unused overrides first' },
    ]);
  }
  const [row] = await tx
    .insert(calendarAvailabilityExceptions)
    .values({ organizationId, calendarId, ...input })
    .returning({ id: calendarAvailabilityExceptions.id });
  if (!row) throw new Error('exception insert returned no row');
  return row;
}

export async function deleteAvailabilityException(
  tx: TenantTx,
  organizationId: string,
  calendarId: string,
  exceptionId: string,
): Promise<void> {
  const deleted = await tx
    .delete(calendarAvailabilityExceptions)
    .where(
      and(
        eq(calendarAvailabilityExceptions.id, exceptionId),
        eq(calendarAvailabilityExceptions.calendarId, calendarId),
        eq(calendarAvailabilityExceptions.organizationId, organizationId),
      ),
    )
    .returning({ id: calendarAvailabilityExceptions.id });
  if (deleted.length === 0) throw new NotFoundError('Date override');
}
