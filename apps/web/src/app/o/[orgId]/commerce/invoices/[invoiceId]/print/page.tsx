import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/commerce/print-button';
import { PrintableDocument } from '@/components/commerce/printable-document';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { getMessages } from '@/i18n';
import type { InvoiceDetail } from '@/lib/commerce-types';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

/** Print-ready invoice (the browser's "Save as PDF" produces the PDF). */
export default async function PrintInvoicePage({
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
  const result = await serverGetJson<{
    organization: { name: string };
    footer: string | null;
    invoice: InvoiceDetail;
  }>(`/app/orgs/${orgId}/commerce/invoices/${invoiceId}/document`);
  const invoice = result?.invoice;
  if (!result || !invoice?.number) notFound();
  const number = invoice.number;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <Link
          href={`/o/${orgId}/commerce/invoices/${invoice.id}`}
          className="text-sm text-slate-600 hover:underline"
        >
          {number}
        </Link>
        <PrintButton label={m.commerce.print} />
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm print:border-0 print:p-0 print:shadow-none">
        <PrintableDocument
          m={m}
          kind="invoice"
          organization={result.organization.name}
          number={number}
          customer={invoice.company?.name ?? invoice.contact?.name ?? ''}
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
          footer={result.footer}
        />
      </div>
    </div>
  );
}
