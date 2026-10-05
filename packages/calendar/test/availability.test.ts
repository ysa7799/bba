import { describe, expect, it } from 'vitest';
import {
  availableStarts,
  mergeIntervals,
  subtractIntervals,
  workingIntervals,
  type SlotRules,
  type WeeklyRule,
} from '../src/availability';
import {
  addDays,
  isValidTimeZone,
  localDate,
  localMinuteOfDay,
  weekdayOf,
  zonedToUtc,
  zoneOffsetMs,
} from '../src/time';

const iso = (ms: number) => new Date(ms).toISOString();
const at = (value: string) => Date.parse(value);
const BAHRAIN = 'Asia/Bahrain';
// Bahrain's working week: Sunday to Thursday.
const WORK_WEEK: WeeklyRule[] = [0, 1, 2, 3, 4].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));
const HALF_HOUR: SlotRules = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  slotIntervalMinutes: 30,
  minimumNoticeMinutes: 0,
  maximumAdvanceDays: 60,
};

describe('time zones', () => {
  it('converts wall-clock times to UTC with the zone offset at that date', () => {
    expect(iso(zonedToUtc('2026-10-06', 9 * 60, BAHRAIN))).toBe('2026-10-06T06:00:00.000Z');
    expect(zoneOffsetMs(at('2026-10-06T06:00:00Z'), BAHRAIN)).toBe(3 * 3_600_000);
    expect(iso(zonedToUtc('2026-10-06', 1440, BAHRAIN))).toBe('2026-10-06T21:00:00.000Z');
    // London: GMT in winter, BST (UTC+1) after 29 March 2026.
    expect(iso(zonedToUtc('2026-03-23', 9 * 60, 'Europe/London'))).toBe('2026-03-23T09:00:00.000Z');
    expect(iso(zonedToUtc('2026-03-30', 9 * 60, 'Europe/London'))).toBe('2026-03-30T08:00:00.000Z');
    // 01:30 does not exist on the spring-forward day: shifted forward by the gap.
    expect(iso(zonedToUtc('2026-03-29', 90, 'Europe/London'))).toBe('2026-03-29T01:30:00.000Z');
    // New York and Kolkata (negative and half-hour offsets).
    expect(iso(zonedToUtc('2026-07-01', 0, 'America/New_York'))).toBe('2026-07-01T04:00:00.000Z');
    expect(iso(zonedToUtc('2026-07-01', 0, 'Asia/Kolkata'))).toBe('2026-06-30T18:30:00.000Z');
  });

  it('reads local dates, weekdays and minutes, and validates zones', () => {
    expect(localDate(at('2026-10-06T22:30:00Z'), BAHRAIN)).toEqual({
      date: '2026-10-07',
      weekday: 3,
    });
    expect(localMinuteOfDay(at('2026-10-06T06:15:00Z'), BAHRAIN)).toBe(9 * 60 + 15);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-09')).toBe(5);
    expect(isValidTimeZone(BAHRAIN)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(() => zonedToUtc('2026-13-45x', 0, BAHRAIN)).toThrow(RangeError);
  });
});

describe('intervals', () => {
  it('merges and subtracts half-open intervals', () => {
    expect(
      mergeIntervals([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 9, end: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 7 },
    ]);
    expect(
      subtractIntervals(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 8, end: 12 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 8 },
    ]);
  });
});

describe('working hours', () => {
  const week = { from: at('2026-10-03T21:00:00Z'), to: at('2026-10-10T21:00:00Z') }; // Sun–Sat local

  it('expands weekly rules in the calendar zone', () => {
    const working = workingIntervals({
      timeZone: BAHRAIN,
      rules: WORK_WEEK,
      exceptions: [],
      ...week,
    });
    expect(working.map((interval) => [iso(interval.start), iso(interval.end)])).toEqual([
      ['2026-10-04T06:00:00.000Z', '2026-10-04T14:00:00.000Z'],
      ['2026-10-05T06:00:00.000Z', '2026-10-05T14:00:00.000Z'],
      ['2026-10-06T06:00:00.000Z', '2026-10-06T14:00:00.000Z'],
      ['2026-10-07T06:00:00.000Z', '2026-10-07T14:00:00.000Z'],
      ['2026-10-08T06:00:00.000Z', '2026-10-08T14:00:00.000Z'],
    ]);
  });

  it('applies days off, partial closures and custom hours', () => {
    const working = workingIntervals({
      timeZone: BAHRAIN,
      rules: WORK_WEEK,
      exceptions: [
        { date: '2026-10-05', kind: 'unavailable', startMinute: null, endMinute: null },
        { date: '2026-10-06', kind: 'unavailable', startMinute: 12 * 60, endMinute: 13 * 60 },
        // Friday: open 10:00–12:00 only.
        { date: '2026-10-09', kind: 'available', startMinute: 10 * 60, endMinute: 12 * 60 },
        // Thursday: custom hours replace 9–17.
        { date: '2026-10-08', kind: 'available', startMinute: 14 * 60, endMinute: 20 * 60 },
      ],
      ...week,
    });
    expect(working.map((interval) => [iso(interval.start), iso(interval.end)])).toEqual([
      ['2026-10-04T06:00:00.000Z', '2026-10-04T14:00:00.000Z'],
      ['2026-10-06T06:00:00.000Z', '2026-10-06T09:00:00.000Z'],
      ['2026-10-06T10:00:00.000Z', '2026-10-06T14:00:00.000Z'],
      ['2026-10-07T06:00:00.000Z', '2026-10-07T14:00:00.000Z'],
      ['2026-10-08T11:00:00.000Z', '2026-10-08T17:00:00.000Z'],
      ['2026-10-09T07:00:00.000Z', '2026-10-09T09:00:00.000Z'],
    ]);
  });

  it('follows daylight-saving changes', () => {
    const working = workingIntervals({
      timeZone: 'Europe/London',
      rules: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
      exceptions: [],
      from: at('2026-03-22T00:00:00Z'),
      to: at('2026-04-01T00:00:00Z'),
    });
    expect(working.map((interval) => iso(interval.start))).toEqual([
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T08:00:00.000Z',
    ]);
  });
});

describe('bookable starts', () => {
  const day = { from: at('2026-10-06T00:00:00Z'), to: at('2026-10-07T00:00:00Z') };
  const working = workingIntervals({
    timeZone: BAHRAIN,
    rules: WORK_WEEK,
    exceptions: [],
    ...day,
  });
  const now = at('2026-10-01T00:00:00Z');

  it('steps through working time and skips busy blocks', () => {
    const free = availableStarts({ working, busy: [], rules: HALF_HOUR, now, ...day });
    expect(free).toHaveLength(16);
    expect(iso(free[0] ?? 0)).toBe('2026-10-06T06:00:00.000Z');
    expect(iso(free.at(-1) ?? 0)).toBe('2026-10-06T13:30:00.000Z');
    const busy = [{ start: at('2026-10-06T07:00:00Z'), end: at('2026-10-06T07:30:00Z') }];
    const withBusy = availableStarts({ working, busy, rules: HALF_HOUR, now, ...day });
    expect(withBusy).toHaveLength(15);
    expect(withBusy.map(iso)).not.toContain('2026-10-06T07:00:00.000Z');
  });

  it('keeps buffers clear on both sides', () => {
    const rules = { ...HALF_HOUR, bufferAfterMinutes: 15, bufferBeforeMinutes: 10 };
    // An existing booking occupies 10:30–11:15 local (07:30–08:15Z) including its buffers.
    const busy = [{ start: at('2026-10-06T07:30:00Z'), end: at('2026-10-06T08:15:00Z') }];
    const free = availableStarts({ working, busy, rules, now, ...day }).map(iso);
    expect(free).not.toContain('2026-10-06T07:00:00.000Z'); // its buffer after would overlap
    expect(free).not.toContain('2026-10-06T08:00:00.000Z'); // its buffer before would overlap
    expect(free).toContain('2026-10-06T08:30:00.000Z');
    expect(free).toContain('2026-10-06T06:30:00.000Z');
  });

  it('respects minimum notice and maximum advance booking', () => {
    const soon = at('2026-10-06T06:10:00Z'); // 09:10 local
    const free = availableStarts({
      working,
      busy: [],
      rules: { ...HALF_HOUR, minimumNoticeMinutes: 60 },
      now: soon,
      ...day,
    });
    expect(iso(free[0] ?? 0)).toBe('2026-10-06T07:30:00.000Z'); // first start after 10:10
    expect(
      availableStarts({
        working,
        busy: [],
        rules: { ...HALF_HOUR, maximumAdvanceDays: 1 },
        now: at('2026-10-05T08:00:00Z'),
        ...day,
      }).map(iso),
    ).toEqual([
      '2026-10-06T06:00:00.000Z',
      '2026-10-06T06:30:00.000Z',
      '2026-10-06T07:00:00.000Z',
      '2026-10-06T07:30:00.000Z',
    ]);
  });

  it('never offers a meeting that runs past the end of working time', () => {
    const rules = { ...HALF_HOUR, durationMinutes: 45 };
    const free = availableStarts({ working, busy: [], rules, now, ...day }).map(iso);
    expect(free.at(-1)).toBe('2026-10-06T13:00:00.000Z'); // 16:00–16:45 local
  });
});
