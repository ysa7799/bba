import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { DocumentLines, InvoiceStatusBadge, money } from '@/components/commerce/document-view';
import { InvoiceActions, RefundButton } from '@/components/commerce/invoice-actions';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { DetailList, Section } from '@/components/crm/detail';
import { getMessages } from '@/i18n';
import type { InvoiceDetail } from '@/lib/commerce-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ orgId: string; invoiceId: string }>;
}) {
  const { orgId, invoiceId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('commerce.invoice.read')) {
    return <CrmForbidden title={m.commerce.invoices} message={m.commerce.forbidden} />;
  }
  const result = await serverGetJson<{ invoice: InvoiceDetail }>(
    `/app/orgs/${orgId}/commerce/invoices/${invoiceId}`,
  );
  if (!result) notFound();
  const { invoice } = result;
  const base = `/o/${orgId}`;
  const methodLabel = (method: string) =>
    (m.commerce.methods as Record<string, string>)[method] ?? method;
  const extra: [string, InvoiceDetail['total'], boolean?][] =
    invoice.status === 'draft'
      ? []
      : [
          [m.commerce.amountPaid, invoice.amountPaid],
          [m.commerce.amountDue, invoice.amountDue, true],
        ];
  if (invoice.amountOverpaid.amountMinor !== '0') {
    extra.push([m.commerce.overpaid, invoice.amountOverpaid, true]);
  }

  return (
    <OrgAccessBoundary orgId={orgId}>
      <div className="mb-2 text-sm">
        <Link href={`${base}/commerce/invoices`} className="text-slate-600 hover:underline">
          {m.commerce.invoices}
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">
          {invoice.number ?? m.commerce.draftNumber}
        </h1>
        <InvoiceStatusBadge m={m} status={invoice.status} overdue={invoice.overdue} />
        <span className="text-sm text-slate-500">{money(invoice.total)}</span>
      </div>
      <div className="mb-6">
        <InvoiceActions invoice={invoice} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title={m.commerce.lines}>
            <DocumentLines m={m} lines={invoice.lines} totals={invoice} extra={extra} />
          </Section>
          <Section title={m.commerce.payments}>
            {invoice.payments.length === 0 ? (
              <p className="text-sm text-slate-500">{m.commerce.noPayments}</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm" data-testid="invoice-payments">
                {invoice.payments.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <div>
                      <p className="font-medium text-slate-900">
                        {money(payment.amount)} · {methodLabel(payment.method)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {payment.source === 'online' ? m.commerce.online : m.commerce.manual} ·{' '}
                        {formatDateTime(payment.receivedAt)}
                        {payment.reference ? ` · ${payment.reference}` : ''}
                        {payment.refunded.amountMinor !== '0'
                          ? ` · ${m.commerce.refunded} ${money(payment.refunded)}`
                          : ''}
                      </p>
                    </div>
                    <RefundButton invoiceId={invoice.id} payment={payment} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {invoice.refunds.length > 0 ? (
            <Section title={m.commerce.refunds}>
              <ul className="divide-y divide-slate-100 text-sm">
                {invoice.refunds.map((refund) => (
                  <li key={refund.id} className="py-2">
                    <span className="font-medium text-slate-900">{money(refund.amount)}</span>{' '}
                    <span className="text-slate-600">
                      · {m.commerce.refundStatus[refund.status]} · {refund.reason} ·{' '}
                      {formatDateTime(refund.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {invoice.attempts.length > 0 ? (
            <Section title={m.commerce.attempts}>
              <ul className="divide-y divide-slate-100 text-sm" data-testid="payment-attempts">
                {invoice.attempts.map((attempt) => (
                  <li key={attempt.paymentId} className="flex justify-between gap-2 py-2">
                    <span>
                      {money(attempt.amount)} ·{' '}
                      {(m.commerce.paymentStatus as Record<string, string>)[attempt.status] ??
                        attempt.status}
                    </span>
                    <span className="text-slate-500">{formatDateTime(attempt.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
        <div className="space-y-4">
          <Section title={m.commerce.customer}>
            <DetailList
              items={[
                [
                  m.commerce.customer,
                  invoice.contact ? (
                    <Link
                      href={`${base}/crm/contacts/${invoice.contact.id}`}
                      className="text-brand-600 hover:underline"
                    >
                      {invoice.contact.name}
                    </Link>
                  ) : null,
                ],
                [m.commerce.company, invoice.company?.name ?? null],
                [m.commerce.currency, invoice.currency],
                [m.commerce.issueDate, formatDate(invoice.issueDate)],
                [m.commerce.dueDate, formatDate(invoice.dueDate)],
                [
                  m.commerce.fromQuote,
                  invoice.quoteId ? (
                    <Link
                      href={`${base}/commerce/quotes/${invoice.quoteId}`}
                      className="text-brand-600 hover:underline"
                    >
                      {m.commerce.quotes}
                    </Link>
                  ) : null,
                ],
              ]}
            />
          </Section>
          {invoice.notes || invoice.terms ? (
            <Section title={m.commerce.notes}>
              {invoice.notes ? (
                <p className="whitespace-pre-line text-sm text-slate-700">{invoice.notes}</p>
              ) : null}
              {invoice.terms ? (
                <p className="mt-3 whitespace-pre-line text-xs text-slate-500">{invoice.terms}</p>
              ) : null}
            </Section>
          ) : null}
        </div>
      </div>
    </OrgAccessBoundary>
  );
}
