import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from './errors';
import { decodeCursor, encodeCursor, paginationQuerySchema, toPage } from './pagination';

describe('pagination', () => {
  it('round-trips cursors', () => {
    const schema = z.object({ createdAt: z.string(), id: z.string() });
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', id: 'abc' });
    expect(decodeCursor(cursor, schema)).toEqual({
      createdAt: '2026-01-01T00:00:00.000Z',
      id: 'abc',
    });
  });

  it('treats tampered cursors as validation errors', () => {
    const schema = z.object({ id: z.string() });
    expect(() => decodeCursor('!!!', schema)).toThrow(ValidationError);
    expect(() => decodeCursor(encodeCursor({ other: 1 }), schema)).toThrow(ValidationError);
  });

  it('bounds the page size', () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(25);
    expect(paginationQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('builds pages from limit + 1 rows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = toPage(
      rows,
      2,
      (row) => ({ id: row.id }),
      (row) => row.id,
    );
    expect(page.data).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
    const last = toPage(
      rows.slice(0, 2),
      2,
      (row) => ({ id: row.id }),
      (row) => row.id,
    );
    expect(last.nextCursor).toBeNull();
  });
});
