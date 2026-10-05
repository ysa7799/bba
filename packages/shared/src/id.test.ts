import { describe, expect, it } from 'vitest';
import { isUuid, newId, uuidv7Timestamp } from './id';

describe('newId (UUIDv7)', () => {
  it('produces valid version 7 UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('encodes the timestamp', () => {
    // Ahead of every id generated so far: the generator is monotonic, so a fixed instant in
    // the past would be (correctly) bumped once the real clock passes it.
    const at = Date.now() + 60_000;
    expect(uuidv7Timestamp(newId(at))).toBe(at);
  });

  it('never goes back in time', () => {
    const latest = uuidv7Timestamp(newId());
    expect(uuidv7Timestamp(newId(Date.UTC(2020, 0, 1)))).toBeGreaterThanOrEqual(latest);
  });

  it('is strictly increasing within a process', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects non-UUID strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid("1' OR '1'='1")).toBe(false);
  });
});
