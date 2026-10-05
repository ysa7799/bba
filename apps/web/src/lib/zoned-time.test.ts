import { describe, expect, it } from 'vitest';
import {
  addDaysToDate,
  formatDayInZone,
  formatTimeInZone,
  isoToZonedInput,
  minutesToTime,
  startOfWeek,
  startOfZonedDay,
  timeToMinutes,
  zonedDate,
  zonedInputToIso,
} from './zoned-time';

describe('zoned time', () => {
  it('converts wall times in an explicit zone, independent of the browser', () => {
    expect(zonedInputToIso('2027-01-10T10:00', 'Asia/Bahrain')).toBe('2027-01-10T07:00:00.000Z');
    expect(zonedInputToIso('2027-07-01T09:00', 'Europe/London')).toBe('2027-07-01T08:00:00.000Z');
    expect(zonedInputToIso('nope', 'Asia/Bahrain')).toBeNull();
    expect(isoToZonedInput('2027-01-10T07:00:00.000Z', 'Asia/Bahrain')).toBe('2027-01-10T10:00');
    expect(zonedDate('2027-01-10T22:30:00.000Z', 'Asia/Bahrain')).toBe('2027-01-11');
    expect(startOfZonedDay('2027-01-10', 'Asia/Bahrain')).toBe('2027-01-09T21:00:00.000Z');
    expect(formatTimeInZone('2027-01-10T07:00:00.000Z', 'Asia/Bahrain')).toBe('10:00');
    expect(formatDayInZone('2027-01-10')).toBe('Sun 10 Jan');
  });

  it('does date and minute arithmetic', () => {
    expect(addDaysToDate('2027-12-31', 1)).toBe('2028-01-01');
    expect(startOfWeek('2027-01-13')).toBe('2027-01-10');
    expect(minutesToTime(570)).toBe('09:30');
    expect(minutesToTime(1440)).toBe('24:00');
    expect(timeToMinutes('17:45')).toBe(1065);
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(timeToMinutes('25:00')).toBeNull();
    expect(timeToMinutes('9:00')).toBeNull();
  });
});
