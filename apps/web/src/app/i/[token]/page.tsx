import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InvoiceStatusBadge } from '@/components/commerce/document-view';
import { PrintButton } from '@/components/commerce/print-button';
import { PrintableDocument } from '@/components/commerce/printable-document';
import { PayButton, PaymentReturn } from '@/components/commerce/public-actions';
import { Alert } from '@/components/ui/alert';
import { format, getMessages } from '@/i18n';
import type { PublicInvoiceView } from '@/lib/commerce-types';
import { formatMoney } from '@/lib/format';
import { pickString } from '@/lib/navigation';
import { serverPublicGetJson } from '@/lib/server-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Invoice',
  // Invoice links are personal: keep them out of search engines and referrers.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The customer's invoice: view, print/save as PDF and pay online when available. */
export default async function PublicInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  if (!TOKEN.test(token)) notFound();
  const view = await serverPublicGetJson<PublicInvoiceView>(`/public/commerce/invoices/${token}`);
  if (!view) notFound();
  const m = getMessages('en');
  const { invoice } = view;
  const returning = pickString(query.payment) !== undefined;
  const partlyPaid = invoice.status === 'open' && invoice.amountPaid.amountMinor !== '0';

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 print:p-0">
      <div className="mb-6 space-y-3 print:hidden">
        {returning ? <PaymentReturn token={token} open={invoice.status === 'open'} /> : null}
        {invoice.status === 'paid' ? (
          <Alert tone="success">{m.commerce.public.paidOn}</Alert>
        ) : invoice.overdue ? (
          <Alert tone="error">{m.commerce.public.overdue}</Alert>
        ) : null}
        {partlyPaid ? (
          <p className="text-sm text-slate-600">
            {format(m.commerce.public.partlyPaid, { amount: formatMoney(invoice.amountPaid) })}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {view.payable ? (
            <PayButton
              token={token}
              label={format(m.commerce.public.pay, { amount: formatMoney(invoice.amountDue) })}
            />
          ) : invoice.status === 'open' ? (
            <p className="text-sm text-slate-600">
              {format(m.commerce.public.payUnavailable, { organization: view.organization.name })}
            </p>
          ) : null}
          <PrintButton label={m.commerce.public.print} />
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:border-0 print:p-0 print:shadow-none">
        <PrintableDocument
          m={m}
          kind="invoice"
          organization={view.organization.name}
          number={invoice.number}
          customer={invoice.customer}
          issueDate={invoice.issueDate}
          dueLabel={m.commerce.dueDate}
          dueDate={invoice.dueDate}
          lines={invoice.lines}
          totals={invoice}
          extra={[
            [m.commerce.amountPaid, invoice.amountPaid],
            [m.commerce.amountDue, invoice.amountDue, true],
          ]}
          notes={invoice.notes}
          terms={invoice.terms}
          footer={invoice.footer}
          status={<InvoiceStatusBadge m={m} status={invoice.status} overdue={invoice.overdue} />}
        />
      </div>
      <p className="mt-6 text-center text-xs text-slate-400 print:hidden">
        {m.commerce.public.poweredBy}
      </p>
    </main>
  );
}
