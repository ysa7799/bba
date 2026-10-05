import Link from 'next/link';
import type { Messages } from '@/i18n/en';
import { cn } from '@/lib/cn';
import type { InvoiceSummary, QuoteSummary } from '@/lib/commerce-types';
import { formatDate } from '@/lib/format';
import { InvoiceStatusBadge, money, QuoteStatusBadge } from './document-view';

/** Status filter tabs for the quote and invoice lists. */
export function StatusTabs({
  m,
  base,
  current,
  filters,
}: {
  m: Messages;
  base: string;
  current: string;
  filters: readonly string[];
}) {
  return (
    <nav aria-label="Status" className="mb-4 flex flex-wrap gap-2 text-sm">
      {filters.map((filter) => (
        <Link
          key={filter}
          href={filter === 'all' ? base : `${base}?status=${filter}`}
          aria-current={current === filter ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5',
            current === filter ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
          )}
        >
          {m.commerce.filters[filter as keyof Messages['commerce']['filters']]}
        </Link>
      ))}
    </nav>
  );
}

export function InvoiceTable({
  m,
  base,
  rows,
}: {
  m: Messages;
  base: string;
  rows: InvoiceSummary[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 text-start font-medium">{m.commerce.number}</th>
            <th className="px-4 py-2 text-start font-medium">{m.commerce.customer}</th>
            <th className="px-4 py-2 text-start font-medium">{m.commerce.dueDate}</th>
            <th className="px-4 py-2 text-end font-medium">{m.commerce.total}</th>
            <th className="px-4 py-2 text-end font-medium">{m.commerce.amountDue}</th>
            <th className="px-4 py-2 text-start font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((invoice) => (
            <tr key={invoice.id} className="border-b border-slate-100" data-testid="invoice-row">
              <td className="px-4 py-2">
                <Link
                  href={`${base}/${invoice.id}`}
                  className="font-medium text-slate-900 hover:underline"
                >
                  {invoice.number ?? m.commerce.draftNumber}
                </Link>
              </td>
              <td className="px-4 py-2 text-slate-700">
                {invoice.company?.name ?? invoice.contact?.name ?? '—'}
              </td>
              <td className="px-4 py-2 text-slate-700">{formatDate(invoice.dueDate)}</td>
              <td className="px-4 py-2 text-end tabular-nums">{money(invoice.total)}</td>
              <td className="px-4 py-2 text-end tabular-nums">{money(invoice.amountDue)}</td>
              <td className="px-4 py-2">
                <InvoiceStatusBadge m={m} status={invoice.status} overdue={invoice.overdue} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QuoteTable({ m, base, rows }: { m: Messages; base: string; rows: QuoteSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2 text-start font-medium">{m.commerce.number}</th>
            <th className="px-4 py-2 text-start font-medium">{m.commerce.customer}</th>
            <th className="px-4 py-2 text-start font-medium">{m.commerce.validUntil}</th>
            <th className="px-4 py-2 text-end font-medium">{m.commerce.total}</th>
            <th className="px-4 py-2 text-start font-medium" />
          </tr>
        </thead>
        <tbody>
          {rows.map((quote) => (
            <tr key={quote.id} className="border-b border-slate-100" data-testid="quote-row">
              <td className="px-4 py-2">
                <Link
                  href={`${base}/${quote.id}`}
                  className="font-medium text-slate-900 hover:underline"
                >
                  {quote.number}
                </Link>
              </td>
              <td className="px-4 py-2 text-slate-700">
                {quote.company?.name ?? quote.contact?.name ?? '—'}
              </td>
              <td className="px-4 py-2 text-slate-700">{formatDate(quote.validUntil)}</td>
              <td className="px-4 py-2 text-end tabular-nums">{money(quote.total)}</td>
              <td className="px-4 py-2">
                <QuoteStatusBadge m={m} status={quote.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Next page" link for keyset-paginated lists. */
export function NextPage({
  m,
  base,
  status,
  cursor,
}: {
  m: Messages;
  base: string;
  status: string;
  cursor: string | null;
}) {
  if (!cursor) return null;
  const params = new URLSearchParams({ cursor });
  if (status !== 'all') params.set('status', status);
  return (
    <div className="mt-4 text-center">
      <Link
        href={`${base}?${params.toString()}`}
        className="text-sm font-medium text-brand-600 hover:underline"
      >
        {m.commerce.loadMore}
      </Link>
    </div>
  );
}
