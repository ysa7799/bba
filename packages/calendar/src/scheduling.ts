/**
 * How an appointment type uses its hosts:
 * - `individual`: one host (the type's only host).
 * - `round_robin`: any one free host; the booking goes to the least-loaded free host.
 * - `collective`: every host must be free; all of them attend.
 */
export type SchedulingMode = 'individual' | 'round_robin' | 'collective';

export interface HostStarts {
  calendarId: string;
  starts: readonly number[];
}

/** Bookable starts for a mode, each with the hosts free at that time (ascending by start). */
export function combineHostStarts(
  mode: SchedulingMode,
  hosts: readonly HostStarts[],
): { start: number; calendarIds: string[] }[] {
  if (hosts.length === 0) return [];
  const free = new Map<number, string[]>();
  for (const host of hosts) {
    for (const start of host.starts) free.set(start, [...(free.get(start) ?? []), host.calendarId]);
  }
  const required = mode === 'collective' ? hosts.length : 1;
  return [...free.entries()]
    .filter(([, calendarIds]) => calendarIds.length >= required)
    .map(([start, calendarIds]) => ({ start, calendarIds }))
    .sort((a, b) => a.start - b.start);
}

export interface HostLoad {
  /** Upcoming scheduled appointments of this type for the host. */
  upcoming: number;
  /** When the host last received a booking of this type (epoch ms), if ever. */
  lastBookedAt: number | null;
}

/**
 * Round-robin choice among free hosts: fewest upcoming bookings of the type first, then the
 * host booked least recently (never-booked hosts first), then a stable id order.
 */
export function rankRoundRobinHosts(
  candidates: readonly string[],
  load: ReadonlyMap<string, HostLoad>,
): string[] {
  const of = (id: string): HostLoad => load.get(id) ?? { upcoming: 0, lastBookedAt: null };
  return [...candidates].sort((a, b) => {
    const la = of(a);
    const lb = of(b);
    if (la.upcoming !== lb.upcoming) return la.upcoming - lb.upcoming;
    const ta = la.lastBookedAt ?? -Infinity;
    const tb = lb.lastBookedAt ?? -Infinity;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.localeCompare(b);
  });
}
