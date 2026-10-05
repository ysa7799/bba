import type { MoneyJson } from './crm-types';

/**
 * Formats an API money value (`{ amount: "12500.250", currency: "BHD" }`) for display without
 * converting through floating point: the decimal string keeps its exact minor units.
 */
export function formatMoney(value: MoneyJson): string {
  const negative = value.amount.startsWith('-');
  const [whole = '0', fraction] = value.amount.replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${value.currency} ${grouped}${fraction ? `.${fraction}` : ''}`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDate(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return value.length === 10
    ? dateFormat.format(date)
    : new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        ...(timeZone ? { timeZone } : {}),
      }).format(date);
}

export function formatDateTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return '—';
  return timeZone
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(new Date(value))
    : dateTimeFormat.format(new Date(value));
}

/** Converts an ISO date-time to the value of a `datetime-local` input (local time). */
export function toDateTimeLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Converts a `datetime-local` input value (browser local time) to ISO 8601 with offset. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
