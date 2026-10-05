import type { Permission } from '@businessos/permissions';
import { currencyExponent, isCurrencyCode } from '@businessos/shared';
import type { Granularity, ReportRange } from './range';

/**
 * A value as reports return it: counts and money are exact decimal strings (money in the
 * currency's minor-unit precision, never a float); `currency` is set for money.
 */
export interface ReportValue {
  key: string;
  value: string;
  currency: string | null;
}

export interface SeriesPoint {
  bucket: string;
  value: string;
  /** Size relative to the largest point of the series, 0–1000 (for bars; exact integer math). */
  scale: number;
}

export interface ReportSeries {
  key: string;
  currency: string | null;
  points: SeriesPoint[];
  total: string;
}

export interface ReportTable {
  key: string;
  /** Column keys (the web app translates them; CSV uses them as headers). */
  columns: string[];
  rows: (string | null)[][];
}

export interface ReportResult {
  key: string;
  range: { from: string; to: string; granularity: Granularity; timezone: string };
  metrics: ReportValue[];
  series: ReportSeries[];
  tables: ReportTable[];
}

/** Who is asking: the report's data is filtered by what they may read. */
export interface ReportContext {
  organizationId: string;
  userId: string | null;
  timezone: string;
  /** Money with no activity is shown as zero in this currency (never converted). */
  defaultCurrency: string;
  permissions: ReadonlySet<Permission>;
}

export function can(ctx: ReportContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

/** Exact decimal text for an amount in minor units (no float, no range assertion). */
export function decimal(minor: bigint, currency: string): string {
  const exponent = isCurrencyCode(currency) ? currencyExponent(currency) : 2;
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function count(key: string, value: bigint | number): ReportValue {
  return { key, value: value.toString(), currency: null };
}

export function moneyValues(
  key: string,
  rows: readonly { currency: string; minor: bigint }[],
  fallbackCurrency?: string,
): ReportValue[] {
  if (rows.length === 0 && fallbackCurrency) {
    return [{ key, value: decimal(0n, fallbackCurrency), currency: fallbackCurrency }];
  }
  return [...rows]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((row) => ({ key, value: decimal(row.minor, row.currency), currency: row.currency }));
}

/** Percentage with one decimal from two integers (e.g. win rate), or null when undefined. */
export function percent(part: bigint, whole: bigint): string | null {
  if (whole <= 0n) return null;
  const tenths = (part * 1000n + whole / 2n) / whole;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()}`;
}

/**
 * A complete series over the range's buckets (missing buckets are zero), with bar scales.
 * `rows` carry integer values (counts or minor units).
 */
export function series(
  range: ReportRange,
  key: string,
  rows: readonly { bucket: string; value: bigint }[],
  currency: string | null = null,
): ReportSeries {
  const byBucket = new Map<string, bigint>();
  for (const row of rows) byBucket.set(row.bucket, (byBucket.get(row.bucket) ?? 0n) + row.value);
  const values = range.buckets.map((bucket) => byBucket.get(bucket) ?? 0n);
  const max = values.reduce((a, b) => (b > a ? b : a), 0n);
  const total = values.reduce((a, b) => a + b, 0n);
  const show = (value: bigint) => (currency ? decimal(value, currency) : value.toString());
  return {
    key,
    currency,
    points: range.buckets.map((bucket, index) => {
      const value = values[index] ?? 0n;
      return {
        bucket,
        value: show(value),
        scale: max > 0n && value > 0n ? Number((value * 1000n) / max) : 0,
      };
    }),
    total: show(total),
  };
}

/** One series per currency, from rows keyed by bucket and currency. */
export function moneySeries(
  range: ReportRange,
  key: string,
  rows: readonly { bucket: string; currency: string; minor: bigint }[],
  fallbackCurrency?: string,
): ReportSeries[] {
  const found = [...new Set(rows.map((row) => row.currency))].sort();
  const currencies = found.length === 0 && fallbackCurrency ? [fallbackCurrency] : found;
  return currencies.map((currency) =>
    series(
      range,
      key,
      rows
        .filter((row) => row.currency === currency)
        .map((row) => ({ bucket: row.bucket, value: row.minor })),
      currency,
    ),
  );
}

export function rangeView(range: ReportRange): ReportResult['range'] {
  return {
    from: range.from,
    to: range.to,
    granularity: range.granularity,
    timezone: range.timezone,
  };
}

/** Rows from `select … ::text` aggregates as bigints (Postgres sums/counts may exceed 2^53). */
export function big(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  return BigInt(value);
}
