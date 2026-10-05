import { z } from 'zod';
import { ValidationError } from './errors';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(512).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Encodes a keyset position as an opaque base64url cursor. */
export function encodeCursor(position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Decodes and validates a cursor; malformed cursors are a client error, never a 500. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Malformed cursor' }]);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Malformed cursor' }]);
  }
  return result.data;
}

/**
 * Given `limit + 1` rows fetched from the database, returns the page and the cursor for the
 * next one (if more rows exist).
 */
export function toPage<Row, Out>(
  rows: Row[],
  limit: number,
  toCursor: (row: Row) => Record<string, string | number>,
  map: (row: Row) => Out,
): Page<Out> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(map),
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}
