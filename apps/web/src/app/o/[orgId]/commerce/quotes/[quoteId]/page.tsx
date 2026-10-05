import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrgAccessBoundary } from '@/components/app/org-access-boundary';
import { DocumentLines, money, QuoteStatusBadge } from '@/components/commerce/document-view';
import { QuoteActions } from '@/components/commerce/quote-actions';
import { CrmForbidden } from '@/components/crm/crm-forbidden';
import { DetailList, Section } from '@/components/crm/detail';
import { getMessages } from '@/i18n';
import type { QuoteDetail } from '@/lib/commerce-types';
import { formatDate, formatDateTime } from '@/lib/format';
import { getOrgAccess } from '@/lib/org-data';
import { serverGetJson } from '@/lib/server-api';

export default async function QuotePage({
  params,
}: {
  params: Promise<{ orgId: string; quoteId: string }>;
}) {
  const { orgId, quoteId } = await params;
  const m = getMessages('en');
  const access = await getOrgAccess(orgId);
  if (!access) notFound();
  if (!access.permissions.includes('commerce.invoice.read')) {
    return <CrmForbidden title={m.commerce.quotes} message={m.commerce.forbidden} />;
  }
  const result = await serverGetJson<{ quote: QuoteDetail }>(
    `/app/orgs/${orgId}/commerce/quotes/${quoteId}`,
  );
  if (!result) notFound();
  const { quote } = result;
  const base = `/o/${orgId}`;

  return (
    <OrgAccessBoundary orgId={orgId}>
      <div className="mb-2 text-sm">
        <Link href={`${base}/commerce/quotes`} className="text-slate-600 hover:underline">
          {m.commerce.quotes}
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">{quote.number}</h1>
        <QuoteStatusBadge m={m} status={quote.status} />
        <span className="text-sm text-slate-500">{money(quote.total)}</span>
      </div>
      <div className="mb-6">
        <QuoteActions quote={quote} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title={m.commerce.lines}>
            <DocumentLines m={m} lines={quote.lines} totals={quote} />
          </Section>
          {quote.notes || quote.terms ? (
            <Section title={m.commerce.notes}>
              {quote.notes ? (
                <p className="whitespace-pre-line text-sm text-slate-700">{quote.notes}</p>
              ) : null}
              {quote.terms ? (
                <p className="mt-3 whitespace-pre-line text-xs text-slate-500">{quote.terms}</p>
              ) : null}
            </Section>
          ) : null}
        </div>
        <Section title={m.commerce.customer}>
          <DetailList
            items={[
              [
                m.commerce.customer,
                quote.contact ? (
                  <Link
                    href={`${base}/crm/contacts/${quote.contact.id}`}
                    className="text-brand-600 hover:underline"
                  >
                    {quote.contact.name}
                  </Link>
                ) : null,
              ],
              [m.commerce.company, quote.company?.name ?? null],
              [m.commerce.currency, quote.currency],
              [m.commerce.issueDate, formatDate(quote.issueDate)],
              [m.commerce.validUntil, formatDate(quote.validUntil)],
              [m.commerce.quoteStatus.sent, formatDateTime(quote.sentAt)],
            ]}
          />
        </Section>
      </div>
    </OrgAccessBoundary>
  );
}
