import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { QuoteStatusBadge } from '@/components/commerce/document-view';
import { PrintButton } from '@/components/commerce/print-button';
import { PrintableDocument } from '@/components/commerce/printable-document';
import { QuoteResponse } from '@/components/commerce/public-actions';
import { Alert } from '@/components/ui/alert';
import { format, getMessages } from '@/i18n';
import type { PublicQuoteView } from '@/lib/commerce-types';
import { serverPublicGetJson } from '@/lib/server-api';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Quote',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The customer's quote: view, print/save as PDF, accept or decline. */
export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();
  const view = await serverPublicGetJson<PublicQuoteView>(`/public/commerce/quotes/${token}`);
  if (!view) notFound();
  const m = getMessages('en');
  const { quote } = view;
  const organization = view.organization.name;
  const message =
    quote.status === 'accepted'
      ? format(m.commerce.public.accepted, { organization })
      : quote.status === 'declined'
        ? m.commerce.public.declined
        : quote.status === 'converted'
          ? m.commerce.public.converted
          : quote.status === 'expired' || (quote.status === 'sent' && !quote.canRespond)
            ? format(m.commerce.public.expired, { organization })
            : null;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 print:p-0">
      <div className="mb-6 space-y-3 print:hidden">
        {message ? (
          <Alert
            tone={quote.status === 'accepted' || quote.status === 'converted' ? 'success' : 'info'}
          >
            {message}
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          {quote.canRespond ? (
            <QuoteResponse token={token} organization={organization} />
          ) : (
            <span />
          )}
          <PrintButton label={m.commerce.public.print} />
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8 print:border-0 print:p-0 print:shadow-none">
        <PrintableDocument
          m={m}
          kind="quote"
          organization={organization}
          number={quote.number}
          customer={quote.customer}
          issueDate={quote.issueDate}
          dueLabel={m.commerce.validUntil}
          dueDate={quote.validUntil}
          lines={quote.lines}
          totals={quote}
          notes={quote.notes}
          terms={quote.terms}
          footer={quote.footer}
          status={<QuoteStatusBadge m={m} status={quote.status} />}
        />
      </div>
      <p className="mt-6 text-center text-xs text-slate-400 print:hidden">
        {m.commerce.public.poweredBy}
      </p>
    </main>
  );
}
