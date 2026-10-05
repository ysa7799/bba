import type { ReportResult } from './result';

/** Values starting with these are formulas in spreadsheet apps (CSV injection). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function cell(value: string | null): string {
  if (value === null) return '';
  const safe = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function line(values: readonly (string | null)[]): string {
  return values.map(cell).join(',');
}

/**
 * A report as CSV (UTF-8 with BOM for Excel): metrics, then each series per bucket, then each
 * table. Section headers are the report's keys; the web app labels them in the UI.
 */
export function reportToCsv(report: ReportResult): string {
  const lines: string[] = [
    line(['report', report.key]),
    line(['from', report.range.from]),
    line(['to', report.range.to]),
    line(['timezone', report.range.timezone]),
    '',
    line(['metric', 'value', 'currency']),
    ...report.metrics.map((metric) => line([metric.key, metric.value, metric.currency])),
  ];
  for (const entry of report.series) {
    lines.push(
      '',
      line(['bucket', entry.currency ? `${entry.key} (${entry.currency})` : entry.key]),
    );
    for (const point of entry.points) lines.push(line([point.bucket, point.value]));
  }
  for (const table of report.tables) {
    lines.push('', line([table.key]), line(table.columns));
    for (const row of table.rows) lines.push(line(row));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
