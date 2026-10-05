/**
 * Time-zone arithmetic on IANA zones with `Intl` only (no dependency): wall-clock dates and
 * minutes in a zone ⇄ UTC instants (epoch milliseconds). DST-safe: offsets are looked up at the
 * instant in question, never assumed constant across a day.
 */

const MINUTE = 60_000;
export const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** True when `timeZone` is a zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function wallClock(utcMs: number, timeZone: string): WallClock {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** Offset of the zone at an instant: local wall time minus UTC, in milliseconds. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const wholeSeconds = Math.floor(utcMs / 1000) * 1000;
  const wall = wallClock(wholeSeconds, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - wholeSeconds;
}

/** `YYYY-MM-DD` → [year, month, day]; throws on malformed input. */
function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * UTC instant of a wall-clock time (`minuteOfDay` minutes after local midnight, 0–1440) on a
 * local date in a zone. In a DST gap the time is shifted forward by the gap; in an overlap
 * (a wall time that occurs twice) one of the two instants is returned.
 */
export function zonedToUtc(date: string, minuteOfDay: number, timeZone: string): number {
  const [year, month, day] = parseDate(date);
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const first = wall - zoneOffsetMs(wall, timeZone);
  const second = wall - zoneOffsetMs(first, timeZone);
  if (first === second) return first;
  // Offsets differ around a transition: prefer the candidate whose wall time matches.
  const matches = (candidate: number) =>
    candidate + zoneOffsetMs(candidate, timeZone) === wall ? candidate : null;
  return matches(Math.min(first, second)) ?? matches(Math.max(first, second)) ?? second;
}

/** Local calendar date (`YYYY-MM-DD`) and weekday (0 = Sunday) of an instant in a zone. */
export function localDate(utcMs: number, timeZone: string): { date: string; weekday: number } {
  const wall = wallClock(utcMs, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`, weekday: wall.weekday };
}

/** Minutes after local midnight of an instant in a zone. */
export function localMinuteOfDay(utcMs: number, timeZone: string): number {
  const wall = wallClock(utcMs, timeZone);
  return wall.hour * 60 + wall.minute;
}

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): number {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const minutes = (n: number): number => n * MINUTE;
