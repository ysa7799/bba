/**
 * Wall-clock ⇄ UTC conversion in an explicit IANA zone with `Intl` only, for scheduling UIs
 * that must not depend on the browser's own zone (staff see the organization's zone, invitees
 * their own). Mirrors the server's scheduling math.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(utcMs: number, timeZone: string): Record<string, number> {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  out.hour = (out.hour ?? 0) % 24;
  return out;
}

function offsetMs(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const p = parts(whole, timeZone);
  return (
    Date.UTC(
      p.year ?? 1970,
      (p.month ?? 1) - 1,
      p.day ?? 1,
      p.hour ?? 0,
      p.minute ?? 0,
      p.second ?? 0,
    ) - whole
  );
}

/** `YYYY-MM-DDTHH:mm` wall time in `timeZone` → ISO instant (null when malformed). */
export function zonedInputToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const wall = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  return new Date(second).toISOString();
}

/** ISO instant → `YYYY-MM-DDTHH:mm` wall time in `timeZone` (for datetime-local inputs). */
export function isoToZonedInput(iso: string, timeZone: string): string {
  const p = parts(Date.parse(iso), timeZone);
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function zonedDate(iso: string | number, timeZone: string): string {
  return isoToZonedInput(new Date(iso).toISOString(), timeZone).slice(0, 10);
}

/** UTC instant of local midnight starting `date` in `timeZone`. */
export function startOfZonedDay(date: string, timeZone: string): string {
  return zonedInputToIso(`${date}T00:00`, timeZone) ?? new Date(`${date}T00:00:00Z`).toISOString();
}

export function addDaysToDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

/** First day (Sunday) of the week containing `date`. */
export function startOfWeek(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return addDaysToDate(date, -weekday);
}

export function formatTimeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso));
}

export function formatDayInZone(date: string): string {
  // `date` is already a local date: format it as a UTC calendar day to avoid any shift.
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

export function formatDateTimeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso));
}

/** The visitor's zone (falls back to the organization's). */
export function browserTimeZone(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

/** `570` → `09:30`; `1440` → `24:00`. */
export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `09:30` → `570` (null when malformed). `24:00` is allowed as an end time. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total >= 0 && total <= 1440 && Number(match[2]) < 60 ? total : null;
}
