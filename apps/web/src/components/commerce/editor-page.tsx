import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import type { PickedRecord } from '@/components/crm/record-picker';
import { PageHeader } from '@/components/ui/card';
import { getMessages } from '@/i18n';
import type { InvoiceDetail, Product, QuoteDetail, TaxRate } from '@/lib/commerce-types';
import type { ContactDetail } from '@/lib/crm-types';
import { getOrgAccess } from '@/lib/org-data';
import { getMe, serverGetJson } from '@/lib/server-api';
import { DocumentEditor } from './document-editor';

/** Shared server page for creating or editing a draft quote or invoice. */
export async function EditorPage({
  orgId,
  kind,
  documentId,
  contactId,
}: {
  orgId: string;
  kind: 'invoice' | 'quote';
  documentId?: string;
  contactId?: string | undefined;
}) {
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  const title = documentId
    ? kind === 'invoice'
      ? m.commerce.editInvoice
      : m.commerce.editQuote
    : kind === 'invoice'
      ? m.commerce.newInvoice
      : m.commerce.newQuote;
  if (!access.permissions.includes('commerce.invoice.create')) {
    return <CrmForbidden title={title} message={m.commerce.forbidden} />;
  }
  const api = `/app/orgs/${orgId}/commerce`;
  const plural = kind === 'invoice' ? 'invoices' : 'quotes';
  const [products, taxRates, loaded] = await Promise.all([
    serverGetJson<{ data: Product[] }>(`${api}/products`),
    serverGetJson<{ data: TaxRate[] }>(`${api}/tax-rates`),
    documentId
      ? serverGetJson<Record<string, InvoiceDetail | QuoteDetail>>(`${api}/${plural}/${documentId}`)
      : Promise.resolve(null),
  ]);
  if (!products || !taxRates) notFound();
  const document = documentId ? loaded?.[kind] : undefined;
  if (documentId && !document) notFound();
  if (document && document.status !== 'draft') notFound();
  let initialContact: PickedRecord | null = null;
  if (
    !document &&
    contactId &&
    /^[0-9a-f-]{36}$/.test(contactId) &&
    access.permissions.includes('crm.contact.read')
  ) {
    const contact = await serverGetJson<{ contact: ContactDetail }>(
      `/app/orgs/${orgId}/crm/contacts/${contactId}`,
    );
    if (contact) initialContact = { id: contact.contact.id, name: contact.contact.displayName };
  }
  const me = await getMe();
  const organization = me?.organizations.find((entry) => entry.id === orgId);

  return (
    <OrgAccessBoundary orgId={orgId}>
      <div className="mb-2 text-sm">
        <Link href={`/o/${orgId}/commerce/${plural}`} className="text-slate-600 hover:underline">
          {kind === 'invoice' ? m.commerce.invoices : m.commerce.quotes}
        </Link>
      </div>
      <PageHeader title={title} />
      <DocumentEditor
        kind={kind}
        {...(document ? { document } : {})}
        products={products.data}
        taxRates={taxRates.data}
        defaultCurrency={organization?.defaultCurrency ?? 'BHD'}
        initialContact={initialContact}
      />
    </OrgAccessBoundary>
  );
}
