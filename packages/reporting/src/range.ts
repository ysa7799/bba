import type { TenantTx } from '@businessos/database';
import { ValidationError } from '@businessos/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** Longest period one report covers (bounded queries, bounded series). */
export const MAX_RANGE_DAYS = 366;

export const reportRangeSchema = z.object({
  /** First day (inclusive), in the organization's time zone. Default: 29 days before `to`. */
  from: z.iso.date().optional(),
  /** Last day (inclusive), in the organization's time zone. Default: today. */
  to: z.iso.date().optional(),
  granularity: z.enum(GRANULARITIES).optional(),
});
export type ReportRangeInput = z.input<typeof reportRangeSchema>;

/** A resolved period: calendar dates in `timezone` plus the matching UTC instants. */
export interface ReportRange {
  from: string;
  to: string;
  granularity: Granularity;
  timezone: string;
  /** Start of `from` in the time zone (inclusive). */
  start: Date;
  /** Start of the day after `to` in the time zone (exclusive). */
  end: Date;
  /** Bucket keys (YYYY-MM-DD of each bucket's first day) covering the period, in order. */
  buckets: string[];
}

export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function parts(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}

function utcDate(date: string): Date {
  const [year, month, day] = parts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = utcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

/** First day of the bucket containing `date` (weeks start on Monday, as in ISO 8601). */
export function bucketStart(date: string, granularity: Granularity): string {
  const value = utcDate(date);
  if (granularity === 'week') {
    value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  } else if (granularity === 'month') {
    value.setUTCDate(1);
  }
  return isoDate(value);
}

function nextBucket(bucket: string, granularity: Granularity): string {
  if (granularity === 'day') return addDays(bucket, 1);
  if (granularity === 'week') return addDays(bucket, 7);
  const value = utcDate(bucket);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return isoDate(value);
}

export function bucketsFor(from: string, to: string, granularity: Granularity): string[] {
  const out: string[] = [];
  for (
    let bucket = bucketStart(from, granularity);
    bucket <= to;
    bucket = nextBucket(bucket, granularity)
  ) {
    out.push(bucket);
  }
  return out;
}

/**
 * Validates a requested period and resolves it in the organization's time zone. The UTC
 * boundaries come from PostgreSQL's time zone rules (the same ones every bucket uses).
 */
export async function resolveRange(
  tx: TenantTx,
  timezone: string,
  rawInput: ReportRangeInput,
  now: Date = new Date(),
): Promise<ReportRange> {
  const input = reportRangeSchema.parse(rawInput);
  const to = input.to ?? localDate(now, timezone);
  const from = input.from ?? addDays(to, -29);
  if (from > to) {
    throw new ValidationError('The start date is after the end date', [
      { path: 'from', message: 'Must be on or before the end date' },
    ]);
  }
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new ValidationError(`A report covers at most ${MAX_RANGE_DAYS} days`, [
      { path: 'to', message: `At most ${MAX_RANGE_DAYS} days after the start date` },
    ]);
  }
  const span = daysBetween(from, to) + 1;
  const granularity = input.granularity ?? (span > 120 ? 'month' : span > 31 ? 'week' : 'day');
  const result = await tx.execute<{ start: string; end: string }>(sql`
    select (extract(epoch from (${from}::date::timestamp at time zone ${timezone})) * 1000)::bigint::text as start,
           (extract(epoch from ((${to}::date + 1)::timestamp at time zone ${timezone})) * 1000)::bigint::text as end
  `);
  const row = result.rows[0];
  if (!row) throw new Error('could not resolve the report period');
  return {
    from,
    to,
    granularity,
    timezone,
    start: new Date(Number(row.start)),
    end: new Date(Number(row.end)),
    buckets: bucketsFor(from, to, granularity),
  };
}

/** SQL for the bucket key of a timestamp column in the range's zone and granularity. */
export function bucketOf(range: ReportRange, column: unknown) {
  return sql<string>`to_char(date_trunc(${range.granularity}, ${column} at time zone ${range.timezone}), 'YYYY-MM-DD')`;
}

/** SQL for the bucket key of a date column (already a calendar date). */
export function dateBucketOf(range: ReportRange, column: unknown) {
  return sql<string>`to_char(date_trunc(${range.granularity}, ${column}::timestamp), 'YYYY-MM-DD')`;
}

/** SQL condition: a timestamp column within the range. */
export function within(range: ReportRange, column: unknown) {
  return sql`${column} >= ${range.start} and ${column} < ${range.end}`;
}

/** SQL condition: a date column within the range. */
export function withinDates(range: ReportRange, column: unknown) {
  return sql`${column} >= ${range.from}::date and ${column} <= ${range.to}::date`;
}
