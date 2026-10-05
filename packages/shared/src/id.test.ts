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
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    expect(uuidv7Timestamp(newId(now + 10_000))).toBe(now + 10_000);
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
