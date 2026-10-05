import { addDays, DAY_MS, localDate, minutes, weekdayOf, zonedToUtc } from './time';

/** Half-open interval `[start, end)` in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** Weekly working hours in the calendar's zone (`weekday` 0 = Sunday; minutes 0–1440). */
export interface WeeklyRule {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * A date override in the calendar's zone. `available` entries replace that day's weekly hours
 * (custom hours); `unavailable` entries remove time (whole day when minutes are null).
 */
export interface DateException {
  date: string;
  kind: 'available' | 'unavailable';
  startMinute: number | null;
  endMinute: number | null;
}

/** Sorts and merges overlapping or touching intervals; drops empty ones. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .toSorted((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** `intervals` minus `remove` (both merged first). */
export function subtractIntervals(
  intervals: readonly Interval[],
  remove: readonly Interval[],
): Interval[] {
  const holes = mergeIntervals(remove);
  const out: Interval[] = [];
  for (const interval of mergeIntervals(intervals)) {
    let cursor = interval.start;
    for (const hole of holes) {
      if (hole.end <= cursor || hole.start >= interval.end) continue;
      if (hole.start > cursor) out.push({ start: cursor, end: hole.start });
      cursor = Math.max(cursor, hole.end);
      if (cursor >= interval.end) break;
    }
    if (cursor < interval.end) out.push({ start: cursor, end: interval.end });
  }
  return out;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Working time of one calendar within `[from, to)`: weekly rules expanded day by day in the
 * calendar's zone, with date overrides applied, converted to UTC instants.
 */
export function workingIntervals(input: {
  timeZone: string;
  rules: readonly WeeklyRule[];
  exceptions: readonly DateException[];
  from: number;
  to: number;
}): Interval[] {
  const { timeZone, rules, exceptions, from, to } = input;
  if (to <= from) return [];
  const byDate = new Map<string, DateException[]>();
  for (const exception of exceptions) {
    byDate.set(exception.date, [...(byDate.get(exception.date) ?? []), exception]);
  }
  const intervals: Interval[] = [];
  const removed: Interval[] = [];
  // One local day of slack on each side covers zones far from UTC.
  let date = addDays(localDate(from, timeZone).date, -1);
  const last = addDays(localDate(to, timeZone).date, 1);
  const toUtc = (day: string, minute: number) => zonedToUtc(day, minute, timeZone);
  while (date <= last) {
    const overrides = byDate.get(date) ?? [];
    const custom = overrides.filter((entry) => entry.kind === 'available');
    const hours =
      custom.length > 0
        ? custom.map((entry) => ({
            startMinute: entry.startMinute ?? 0,
            endMinute: entry.endMinute ?? 1440,
          }))
        : rules.filter((rule) => rule.weekday === weekdayOf(date));
    for (const hour of hours) {
      intervals.push({ start: toUtc(date, hour.startMinute), end: toUtc(date, hour.endMinute) });
    }
    for (const entry of overrides) {
      if (entry.kind !== 'unavailable') continue;
      removed.push({
        start: toUtc(date, entry.startMinute ?? 0),
        end: toUtc(date, entry.endMinute ?? 1440),
      });
    }
    date = addDays(date, 1);
  }
  return subtractIntervals(intervals, removed)
    .map((interval) => ({ start: Math.max(interval.start, from), end: Math.min(interval.end, to) }))
    .filter((interval) => interval.end > interval.start);
}

export interface SlotRules {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Spacing of start times, counted from the start of each working block. */
  slotIntervalMinutes: number;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
}

/** The time a booking occupies on its host's calendar: the meeting plus its buffers. */
export function blockedRange(start: number, rules: SlotRules): Interval {
  return {
    start: start - minutes(rules.bufferBeforeMinutes),
    end: start + minutes(rules.durationMinutes + rules.bufferAfterMinutes),
  };
}

/**
 * Bookable start times for one host in `[from, to)`. A start qualifies when the meeting lies
 * inside working time, its buffered range overlaps no busy block (existing bookings are stored
 * with their own buffers, the same rule the database exclusion constraint enforces), and it
 * respects minimum notice and maximum advance booking.
 */
export function availableStarts(input: {
  working: readonly Interval[];
  busy: readonly Interval[];
  rules: SlotRules;
  now: number;
  from: number;
  to: number;
}): number[] {
  const { working, rules, now } = input;
  const busy = mergeIntervals(input.busy);
  const duration = minutes(rules.durationMinutes);
  const step = minutes(Math.max(rules.slotIntervalMinutes, 5));
  const earliest = Math.max(input.from, now + minutes(rules.minimumNoticeMinutes));
  const latest = Math.min(input.to, now + rules.maximumAdvanceDays * DAY_MS);
  const starts: number[] = [];
  for (const block of mergeIntervals(working)) {
    const offset = Math.max(0, Math.ceil((earliest - block.start) / step)) * step;
    for (let start = block.start + offset; start + duration <= block.end; start += step) {
      if (start >= latest) break;
      const range = blockedRange(start, rules);
      if (!busy.some((interval) => overlaps(interval, range))) starts.push(start);
    }
  }
  return starts;
}
