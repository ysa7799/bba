import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { InvoiceTable, NextPage, StatusTabs } from '@/components/commerce/document-list';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { EmptyState, PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import { INVOICE_FILTERS, type InvoiceSummary } from '@/lib/commerce-types';
import { pickString } from '@/lib/navigation';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('commerce.invoice.read')) {
    return <CrmForbidden title={m.commerce.invoices} message={m.commerce.forbidden} />;
  }
  const requested = pickString(query.status) ?? 'all';
  const status = (INVOICE_FILTERS as readonly string[]).includes(requested) ? requested : 'all';
  const cursor = pickString(query.cursor);
  const search = new URLSearchParams({ limit: '50' });
  if (status !== 'all') search.set('status', status);
  if (cursor) search.set('cursor', cursor);
  const list = await serverGetJson<{ data: InvoiceSummary[]; nextCursor: string | null }>(
    `/app/orgs/${orgId}/commerce/invoices?${search.toString()}`,
  );
  if (!list) notFound();
  const base = `/o/${orgId}/commerce/invoices`;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <PageHeader
        title={m.commerce.invoices}
        actions={
          access.permissions.includes('commerce.invoice.create') ? (
            <Link
              href={`${base}/new`}
              className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              {m.commerce.newInvoice}
            </Link>
          ) : null
        }
      />
      <StatusTabs m={m} base={base} current={status} filters={INVOICE_FILTERS} />
      {list.data.length === 0 ? (
        <EmptyState title={status === 'all' ? m.commerce.emptyInvoices : m.commerce.emptyFiltered}>
          {status === 'all' ? m.commerce.emptyInvoicesHint : null}
        </EmptyState>
      ) : (
        <InvoiceTable m={m} base={base} rows={list.data} />
      )}
      <NextPage m={m} base={base} status={status} cursor={list.nextCursor} />
    </OrgAccessBoundary>
  );
}
