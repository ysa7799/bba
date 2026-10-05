/**
 * First day (YYYY-MM-01) of the calendar month containing `at`, in the organization's IANA
 * timezone. Quotas reset at local midnight on the 1st, not at UTC midnight.
 */
export function monthPeriodStart(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('could not compute billing period');
  return `${year}-${month}-01`;
}
