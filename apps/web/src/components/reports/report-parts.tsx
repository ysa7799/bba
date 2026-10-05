import type { Messages } from '@/i18n/en';
import { format } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import {
  PERCENT_METRICS,
  type Granularity,
  type ReportSeries,
  type ReportTable,
  type ReportValue,
} from '@/lib/report-types';

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/** Counts with thousands separators; money via the exact decimal formatter. */
export function displayValue(value: ReportValue | { value: string; currency: string | null }) {
  if (value.currency) return formatMoney({ amount: value.value, currency: value.currency });
  return /^\d+$/.test(value.value)
    ? value.value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : value.value;
}

export function metricText(metric: ReportValue): string {
  if (PERCENT_METRICS.has(metric.key)) return metric.value === '—' ? '—' : `${metric.value}%`;
  return displayValue(metric);
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function bucketLabel(m: Messages, bucket: string, granularity: Granularity): string {
  const date = new Date(`${bucket}T00:00:00Z`);
  if (granularity === 'month') return monthFormat.format(date);
  const day = dayFormat.format(date);
  return granularity === 'week' ? format(m.reports.weekOf, { date: day }) : day;
}

/** A headline number (stat tile). */
export function StatTile({ m, metric }: { m: Messages; metric: ReportValue }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4" data-testid="stat-tile">
      <p className="text-xs font-medium text-slate-500">{label(m.reports.metrics, metric.key)}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{metricText(metric)}</p>
    </div>
  );
}

/**
 * One series as columns over time: one hue, one axis, bars ≤ 24px with a rounded data end.
 * Each column is focusable and shows its period and value on hover/focus; the same values
 * are in the data table below the chart.
 */
export function BarChart({
  m,
  series,
  granularity,
  compact = false,
}: {
  m: Messages;
  series: ReportSeries;
  granularity: Granularity;
  compact?: boolean;
}) {
  const title = `${label(m.reports.series, series.key)}${series.currency ? ` (${series.currency})` : ''}`;
  const value = (text: string) => displayValue({ value: text, currency: series.currency });
  const points = series.points;
  const empty = points.every((point) => point.scale === 0);
  const first = points[0];
  const last = points.at(-1);
  return (
    <figure className="space-y-2" data-testid="bar-chart">
      <figcaption className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-slate-900">{title}</span>
        <span className="tabular-nums text-slate-600">
          {m.reports.total}: {value(series.total)}
        </span>
      </figcaption>
      {empty ? (
        <p className="text-xs text-slate-500" data-testid="chart-empty">
          {m.reports.empty}
        </p>
      ) : null}
      <div
        className={cn(
          'flex items-end gap-[2px] border-b border-slate-300',
          empty ? 'h-4' : compact ? 'h-16' : 'h-40',
        )}
        role="list"
        aria-label={title}
      >
        {points.map((point, index) => {
          const period = bucketLabel(m, point.bucket, granularity);
          // Tooltips open towards the chart's middle so they never leave it.
          const anchor = index < points.length / 2 ? 'left-0' : 'right-0';
          return (
            <div
              key={point.bucket}
              role="listitem"
              tabIndex={0}
              aria-label={`${period}: ${value(point.value)}`}
              className="group relative flex h-full max-w-6 flex-1 items-end focus:outline-none"
            >
              <div
                className="w-full rounded-t-[4px] bg-brand-500 group-hover:bg-brand-700 group-focus:bg-brand-700"
                style={{
                  height: `${(point.scale / 10).toFixed(1)}%`,
                  minHeight: point.scale > 0 ? 2 : 0,
                }}
              />
              <span
                className={cn(
                  'pointer-events-none absolute bottom-full z-10 mb-1 hidden whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white group-hover:block group-focus:block',
                  anchor,
                )}
              >
                <strong className="font-semibold tabular-nums">{value(point.value)}</strong>{' '}
                <span className="text-slate-300">{period}</span>
              </span>
            </div>
          );
        })}
      </div>
      {first && last && !compact ? (
        <div className="flex justify-between text-xs text-slate-500">
          <span>{bucketLabel(m, first.bucket, granularity)}</span>
          <span>{bucketLabel(m, last.bucket, granularity)}</span>
        </div>
      ) : null}
      {compact ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-slate-600">{m.reports.showData}</summary>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 text-start font-medium">{m.reports.period}</th>
                <th className="py-1 text-end font-medium">{title}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.bucket} className="border-t border-slate-100">
                  <td className="py-1">{bucketLabel(m, point.bucket, granularity)}</td>
                  <td className="py-1 text-end tabular-nums">{value(point.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}

export function DataTable({ m, table }: { m: Messages; table: ReportTable }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4" data-testid="report-table">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">
        {label(m.reports.tables, table.key)}
      </h3>
      {table.rows.length === 0 ? (
        <p className="text-sm text-slate-500">{m.reports.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                {table.columns.map((column, index) => (
                  <th
                    key={column}
                    className={cn('py-2 font-medium', index === 0 ? 'text-start' : 'text-end')}
                  >
                    {label(m.reports.columns, column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-slate-100">
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={cn(
                        'py-2',
                        index === 0
                          ? 'text-start text-slate-900'
                          : 'text-end tabular-nums text-slate-700',
                      )}
                    >
                      {cell ?? m.reports.hidden}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
