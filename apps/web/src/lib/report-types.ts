// Response shapes of `/app/orgs/:orgId/reports/*` (mirrors `@businessos/reporting`).

export type Granularity = 'day' | 'week' | 'month';

export interface ReportValue {
  key: string;
  /** Exact decimal text: a count, a money amount (with `currency`) or a percentage. */
  value: string;
  currency: string | null;
}

export interface ReportSeries {
  key: string;
  currency: string | null;
  /** `scale` is the bar size relative to the largest point, 0–1000 (computed by the API). */
  points: { bucket: string; value: string; scale: number }[];
  total: string;
}

export interface ReportTable {
  key: string;
  columns: string[];
  rows: (string | null)[][];
}

export interface ReportRangeView {
  from: string;
  to: string;
  granularity: Granularity;
  timezone: string;
}

export interface ReportResult {
  key: string;
  range: ReportRangeView;
  metrics: ReportValue[];
  series: ReportSeries[];
  tables: ReportTable[];
}

export interface Dashboard {
  range: ReportRangeView;
  widgets: { report: string; metrics: ReportValue[]; series: ReportSeries[] }[];
}

export const PERCENT_METRICS = new Set(['win_rate', 'no_show_rate', 'success_rate']);
