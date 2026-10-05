import type { ReactNode } from 'react';
import type { Messages } from '@/i18n/en';
import { cn } from '@/lib/cn';
import type { DocumentLine, InvoiceStatus, Money, QuoteStatus } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';

export function money(value: Money): string {
  return formatMoney(value);
}

const INVOICE_TONES: Record<InvoiceStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  open: 'bg-blue-50 text-blue-700',
  paid: 'bg-green-50 text-green-700',
  void: 'bg-slate-100 text-slate-500 line-through',
};

const QUOTE_TONES: Record<QuoteStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-blue-50 text-blue-700',
  accepted: 'bg-green-50 text-green-700',
  declined: 'bg-red-50 text-red-700',
  expired: 'bg-amber-50 text-amber-700',
  converted: 'bg-violet-50 text-violet-700',
};

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', className)}
      data-testid="status-badge"
    >
      {children}
    </span>
  );
}

export function InvoiceStatusBadge({
  m,
  status,
  overdue,
}: {
  m: Messages;
  status: InvoiceStatus;
  overdue: boolean;
}) {
  if (overdue) return <Badge className="bg-red-50 text-red-700">{m.commerce.overdue}</Badge>;
  return <Badge className={INVOICE_TONES[status]}>{m.commerce.invoiceStatus[status]}</Badge>;
}

export function QuoteStatusBadge({ m, status }: { m: Messages; status: QuoteStatus }) {
  return <Badge className={QUOTE_TONES[status]}>{m.commerce.quoteStatus[status]}</Badge>;
}

/** Line items and totals exactly as computed by the API (no arithmetic in the browser). */
export function DocumentLines({
  m,
  lines,
  totals,
  extra,
}: {
  m: Messages;
  lines: DocumentLine[];
  totals: { subtotal: Money; discount: Money; tax: Money; total: Money };
  extra?: [label: string, value: Money, emphasis?: boolean][];
}) {
  const hasDiscount = totals.discount.amountMinor !== '0';
  const hasTax = lines.some((line) => line.tax !== null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="document-lines">
        <thead>
          <tr className="border-b border-slate-200 text-start text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pe-3 text-start font-medium">{m.commerce.line.description}</th>
            <th className="px-3 py-2 text-end font-medium">{m.commerce.line.quantity}</th>
            <th className="px-3 py-2 text-end font-medium">{m.commerce.line.unitAmount}</th>
            {hasDiscount ? (
              <th className="px-3 py-2 text-end font-medium">{m.commerce.line.discount}</th>
            ) : null}
            {hasTax ? (
              <th className="px-3 py-2 text-end font-medium">{m.commerce.line.tax}</th>
            ) : null}
            <th className="py-2 ps-3 text-end font-medium">{m.commerce.line.amount}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-slate-100 align-top">
              <td className="whitespace-pre-line py-2 pe-3 text-slate-900">{line.description}</td>
              <td className="px-3 py-2 text-end tabular-nums">{line.quantity}</td>
              <td className="px-3 py-2 text-end tabular-nums">{money(line.unitAmount)}</td>
              {hasDiscount ? (
                <td className="px-3 py-2 text-end tabular-nums">
                  {line.discountPercent === '0' ? '—' : `${line.discountPercent}%`}
                </td>
              ) : null}
              {hasTax ? (
                <td className="px-3 py-2 text-end text-slate-600">
                  {line.tax ? `${line.tax.name} ${line.tax.percent}%` : '—'}
                </td>
              ) : null}
              <td className="py-2 ps-3 text-end tabular-nums">{money(line.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="ms-auto mt-4 w-full max-w-xs space-y-1 text-sm" data-testid="document-totals">
        <TotalRow label={m.commerce.subtotal} value={totals.subtotal} />
        {hasDiscount ? (
          <TotalRow label={m.commerce.discount} value={totals.discount} negative />
        ) : null}
        {hasTax || totals.tax.amountMinor !== '0' ? (
          <TotalRow label={m.commerce.tax} value={totals.tax} />
        ) : null}
        <TotalRow label={m.commerce.total} value={totals.total} emphasis />
        {extra?.map(([label, value, emphasis]) => (
          <TotalRow key={label} label={label} value={value} emphasis={emphasis ?? false} />
        ))}
      </dl>
    </div>
  );
}

function TotalRow({
  label,
  value,
  emphasis = false,
  negative = false,
}: {
  label: string;
  value: Money;
  emphasis?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-4',
        emphasis ? 'border-t border-slate-200 pt-1 font-semibold text-slate-900' : 'text-slate-600',
      )}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums" data-testid={`total-${label}`}>
        {negative ? '−' : ''}
        {money(value)}
      </dd>
    </div>
  );
}
