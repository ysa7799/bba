import { describe, expect, it } from 'vitest';
import { combineHostStarts, rankRoundRobinHosts } from '../src/scheduling';

describe('scheduling modes', () => {
  const hosts = [
    { calendarId: 'a', starts: [1, 2, 3] },
    { calendarId: 'b', starts: [2, 3, 4] },
  ];

  it('offers any free host for round robin and only common times for collective', () => {
    expect(combineHostStarts('round_robin', hosts)).toEqual([
      { start: 1, calendarIds: ['a'] },
      { start: 2, calendarIds: ['a', 'b'] },
      { start: 3, calendarIds: ['a', 'b'] },
      { start: 4, calendarIds: ['b'] },
    ]);
    expect(combineHostStarts('collective', hosts)).toEqual([
      { start: 2, calendarIds: ['a', 'b'] },
      { start: 3, calendarIds: ['a', 'b'] },
    ]);
    expect(combineHostStarts('individual', [hosts[0] ?? { calendarId: 'x', starts: [] }])).toEqual([
      { start: 1, calendarIds: ['a'] },
      { start: 2, calendarIds: ['a'] },
      { start: 3, calendarIds: ['a'] },
    ]);
    expect(combineHostStarts('collective', [])).toEqual([]);
  });

  it('ranks round-robin hosts by load, then by least recent booking', () => {
    const load = new Map([
      ['a', { upcoming: 2, lastBookedAt: 10 }],
      ['b', { upcoming: 1, lastBookedAt: 50 }],
      ['c', { upcoming: 1, lastBookedAt: 20 }],
    ]);
    expect(rankRoundRobinHosts(['a', 'b', 'c'], load)).toEqual(['c', 'b', 'a']);
    // A host with no bookings yet goes first.
    expect(rankRoundRobinHosts(['b', 'c', 'd'], load)).toEqual(['d', 'c', 'b']);
  });
});
