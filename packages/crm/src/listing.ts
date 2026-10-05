import { decodeCursor, encodeCursor, ValidationError, type Page } from '@businessos/shared';
import { asc, desc, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Keyset pagination over one sort expression plus the id tiebreaker. Cursor values are taken
 * from the database as text (`::text`), so timestamps keep their microsecond precision and
 * pages never skip or repeat rows.
 */
export interface SortSpec {
  name: string;
  expression: SQL | AnyColumn;
  direction: 'asc' | 'desc';
  kind: 'timestamp' | 'date' | 'text' | 'number';
}

const cursorSchema = z.object({ s: z.string().max(40), v: z.string().max(400), id: z.uuid() });

export function sortValue(spec: SortSpec): SQL<string> {
  return sql<string>`(${spec.expression})::text`;
}

function typed(spec: SortSpec, value: string): SQL {
  switch (spec.kind) {
    case 'timestamp':
      return sql`${value}::timestamptz`;
    case 'number':
      return sql`${value}::numeric`;
    case 'date':
      return sql`${value}::date`;
    case 'text':
      return sql`${value}`;
  }
}

/** Condition selecting rows after the cursor (or undefined on the first page). */
export function afterCursor(
  spec: SortSpec,
  idColumn: AnyColumn,
  cursor: string | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  const position = decodeCursor(cursor, cursorSchema);
  if (position.s !== spec.name) {
    throw new ValidationError('Invalid cursor', [
      { path: 'cursor', message: 'Cursor belongs to a different sort order' },
    ]);
  }
  const comparator = spec.direction === 'asc' ? sql`>` : sql`<`;
  return sql`(${spec.expression}, ${idColumn}) ${comparator} (${typed(spec, position.v)}, ${position.id}::uuid)`;
}

export function orderFor(spec: SortSpec, idColumn: AnyColumn): SQL[] {
  return spec.direction === 'asc'
    ? [asc(spec.expression), asc(idColumn)]
    : [desc(spec.expression), desc(idColumn)];
}

/** Builds a page from `limit + 1` rows that carry `sortValue` and `id`. */
export function keysetPage<Row extends { id: string; sortValue: string }, Out>(
  spec: SortSpec,
  rows: Row[],
  limit: number,
  map: (row: Row) => Out,
): Page<Out> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(map),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ s: spec.name, v: last.sortValue, id: last.id })
        : null,
  };
}
