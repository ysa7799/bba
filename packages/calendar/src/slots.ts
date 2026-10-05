import {
  calendarAvailabilityExceptions,
  calendarAvailabilityRules,
  calendarBusyBlocks,
  calendars,
  withTenant,
  type AppointmentType,
  type Database,
  type TenantScope,
  type TenantTx,
} from '@businessos/database';
import { ValidationError } from '@businessos/shared';
import { and, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import {
  availableStarts,
  workingIntervals,
  type DateException,
  type Interval,
  type SlotRules,
  type WeeklyRule,
} from './availability';
import { getAppointmentTypeRow, hostCalendarIds } from './appointment-types';
import { externalBusyTimes, resolveConnections, type CalendarServices } from './connections';
import { combineHostStarts } from './scheduling';
import { DAY_MS } from './time';

/** Longest window a single availability request may cover. */
export const MAX_SLOT_RANGE_DAYS = 31;

export interface HostSchedule {
  calendarId: string;
  timezone: string;
  isActive: boolean;
  rules: WeeklyRule[];
  exceptions: DateException[];
  /** Existing bookings on this calendar, including their buffers. */
  busy: Interval[];
}

export interface SchedulingData {
  type: AppointmentType;
  hosts: HostSchedule[];
}

export function slotRules(type: AppointmentType): SlotRules {
  return {
    durationMinutes: type.durationMinutes,
    bufferBeforeMinutes: type.bufferBeforeMinutes,
    bufferAfterMinutes: type.bufferAfterMinutes,
    slotIntervalMinutes: type.slotIntervalMinutes,
    minimumNoticeMinutes: type.minimumNoticeMinutes,
    maximumAdvanceDays: type.maximumAdvanceDays,
  };
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Everything needed to compute a type's availability over `range` (one tenant query set). */
export async function loadSchedulingData(
  tx: TenantTx,
  organizationId: string,
  typeId: string,
  range: Interval,
  options: { excludeAppointmentId?: string; calendarIds?: readonly string[] } = {},
): Promise<SchedulingData> {
  const type = await getAppointmentTypeRow(tx, organizationId, typeId);
  const hostIds = options.calendarIds ?? (await hostCalendarIds(tx, typeId));
  if (hostIds.length === 0) return { type, hosts: [] };
  // Generous margins: local dates differ from UTC dates by up to a day and buffers extend
  // bookings beyond their own times.
  const from = range.start - 2 * DAY_MS;
  const to = range.end + 2 * DAY_MS;
  const calendarRows = await tx
    .select()
    .from(calendars)
    .where(and(eq(calendars.organizationId, organizationId), inArray(calendars.id, [...hostIds])));
  const rules = await tx
    .select()
    .from(calendarAvailabilityRules)
    .where(inArray(calendarAvailabilityRules.calendarId, [...hostIds]));
  const exceptions = await tx
    .select()
    .from(calendarAvailabilityExceptions)
    .where(
      and(
        inArray(calendarAvailabilityExceptions.calendarId, [...hostIds]),
        gte(calendarAvailabilityExceptions.date, isoDate(from)),
        lte(calendarAvailabilityExceptions.date, isoDate(to)),
      ),
    );
  const busy = await tx
    .select()
    .from(calendarBusyBlocks)
    .where(
      and(
        inArray(calendarBusyBlocks.calendarId, [...hostIds]),
        lt(calendarBusyBlocks.startsAt, new Date(to)),
        gt(calendarBusyBlocks.endsAt, new Date(from)),
        options.excludeAppointmentId
          ? ne(calendarBusyBlocks.appointmentId, options.excludeAppointmentId)
          : undefined,
      ),
    );
  const hosts = hostIds.flatMap((calendarId): HostSchedule[] => {
    const calendar = calendarRows.find((row) => row.id === calendarId);
    if (!calendar) return [];
    return [
      {
        calendarId,
        timezone: calendar.timezone,
        isActive: calendar.isActive,
        rules: rules
          .filter((rule) => rule.calendarId === calendarId)
          .map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute })),
        exceptions: exceptions
          .filter((exception) => exception.calendarId === calendarId)
          .map(({ date, kind, startMinute, endMinute }) => ({
            date,
            kind,
            startMinute,
            endMinute,
          })),
        busy: busy
          .filter((block) => block.calendarId === calendarId)
          .map((block) => ({ start: block.startsAt.getTime(), end: block.endsAt.getTime() })),
      },
    ];
  });
  return { type, hosts };
}

/**
 * Bookable starts of a type in `range`, each with the hosts free at that time. Hosts that are
 * inactive or whose external calendar cannot be read offer no time; a collective type then has
 * no availability at all.
 */
export function computeSlots(
  data: SchedulingData,
  external: ReadonlyMap<string, Interval[] | null>,
  range: Interval,
  now: number,
): { start: number; calendarIds: string[] }[] {
  const rules = slotRules(data.type);
  const hosts = data.hosts.map((host) => {
    const externalBusy = external.get(host.calendarId);
    if (!host.isActive || externalBusy === null) return { calendarId: host.calendarId, starts: [] };
    // Expanded from a day earlier so working blocks are never clipped at the window start:
    // start times stay on the grid of the real block (09:00, 09:30…) whatever `from` or `now`.
    const working = workingIntervals({
      timeZone: host.timezone,
      rules: host.rules,
      exceptions: host.exceptions,
      from: range.start - DAY_MS,
      to: range.end + rules.durationMinutes * 60_000,
    });
    return {
      calendarId: host.calendarId,
      starts: availableStarts({
        working,
        busy: [...host.busy, ...(externalBusy ?? [])],
        rules,
        now,
        from: range.start,
        to: range.end,
      }),
    };
  });
  return combineHostStarts(data.type.schedulingMode, hosts);
}

/** Validates and clamps a requested availability window. */
export function slotRange(from: number, to: number, now: number): Interval {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new ValidationError('Invalid range', [{ path: 'to', message: 'Must be after from' }]);
  }
  if (to - from > MAX_SLOT_RANGE_DAYS * DAY_MS) {
    throw new ValidationError('Range too long', [
      { path: 'to', message: `At most ${MAX_SLOT_RANGE_DAYS} days per request` },
    ]);
  }
  return { start: Math.max(from, now), end: to };
}

/**
 * Available times for an appointment type: tenant data in one transaction, external calendar
 * busy times fetched outside it (no transaction is held open across provider calls).
 */
export async function listAvailableSlots(
  db: Database,
  services: CalendarServices,
  scope: TenantScope,
  typeId: string,
  requested: { from: number; to: number },
  now = Date.now(),
): Promise<{ start: number; calendarIds: string[] }[]> {
  const range = slotRange(requested.from, requested.to, now);
  if (range.end <= range.start) return [];
  const { data, connections } = await withTenant(db, scope, async (tx) => {
    const loaded = await loadSchedulingData(tx, scope.organizationId, typeId, range);
    return {
      data: loaded,
      connections: await resolveConnections(
        tx,
        scope.organizationId,
        services,
        loaded.hosts.map((host) => host.calendarId),
        'conflicts',
      ),
    };
  });
  const external = await externalBusyTimes(services, connections, {
    start: range.start - DAY_MS,
    end: range.end + DAY_MS,
  });
  return computeSlots(data, external, range, now);
}
