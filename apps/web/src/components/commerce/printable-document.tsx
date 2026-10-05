import type { ReactNode } from 'react';
import type { Messages } from '@/i18n/en';
import type { DocumentLine, Money } from '@/lib/commerce-types';
import { formatDate } from '@/lib/format';
import { DocumentLines } from './document-view';

/**
 * The branded, print-ready document (invoice or quote). Printing to PDF from the browser gives
 * the PDF; the layout uses only print-safe styles and no app chrome.
 */
export function PrintableDocument({
  m,
  kind,
  organization,
  number,
  customer,
  issueDate,
  dueLabel,
  dueDate,
  lines,
  totals,
  extra,
  notes,
  terms,
  footer,
  status,
}: {
  m: Messages;
  kind: 'invoice' | 'quote';
  organization: string;
  number: string;
  customer: string;
  issueDate: string | null;
  dueLabel: string;
  dueDate: string | null;
  lines: DocumentLine[];
  totals: { subtotal: Money; discount: Money; tax: Money; total: Money };
  extra?: [string, Money, boolean?][];
  notes: string | null;
  terms: string | null;
  footer: string | null;
  status?: ReactNode;
}) {
  return (
    <article
      className="mx-auto max-w-3xl bg-white text-slate-900 print:max-w-none"
      data-testid="printable-document"
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <p className="text-lg font-semibold">{organization}</p>
        </div>
        <div className="text-end">
          <p className="text-2xl font-semibold uppercase tracking-wide text-slate-700">
            {kind === 'invoice' ? m.commerce.public.invoice : m.commerce.public.quote}
          </p>
          <p className="font-mono text-sm" data-testid="document-number">
            {number}
          </p>
          {status ? <div className="mt-1">{status}</div> : null}
        </div>
      </header>
      <section className="grid gap-4 py-6 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {kind === 'invoice' ? m.commerce.public.billedTo : m.commerce.public.preparedFor}
          </p>
          <p className="mt-1 font-medium">{customer || '—'}</p>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:text-end">
          <dt className="text-slate-500">{m.commerce.issueDate}</dt>
          <dd>{formatDate(issueDate)}</dd>
          <dt className="text-slate-500">{dueLabel}</dt>
          <dd>{formatDate(dueDate)}</dd>
        </dl>
      </section>
      <DocumentLines m={m} lines={lines} totals={totals} {...(extra ? { extra } : {})} />
      {notes ? <p className="mt-8 whitespace-pre-line text-sm text-slate-700">{notes}</p> : null}
      {terms ? <p className="mt-4 whitespace-pre-line text-xs text-slate-500">{terms}</p> : null}
      {footer ? (
        <footer className="mt-10 whitespace-pre-line border-t border-slate-200 pt-4 text-xs text-slate-500">
          {footer}
        </footer>
      ) : null}
    </article>
  );
}
