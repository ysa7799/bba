import type { ActivityProjector, ProjectorMap } from '@businessos/activities';
import { commerceInvoices, commerceQuotes, type TenantTx } from '@businessos/database';
import type { EventPayload } from '@businessos/events';
import { and, eq } from 'drizzle-orm';
import { moneyView } from './money';

function amount(minor: bigint, currency: string): string {
  return `${currency} ${moneyView(minor, currency).amount}`;
}

async function quoteOf(tx: TenantTx, organizationId: string, id: string) {
  const [quote] = await tx
    .select()
    .from(commerceQuotes)
    .where(and(eq(commerceQuotes.id, id), eq(commerceQuotes.organizationId, organizationId)));
  return quote ?? null;
}

async function invoiceOf(tx: TenantTx, organizationId: string, id: string) {
  const [invoice] = await tx
    .select()
    .from(commerceInvoices)
    .where(and(eq(commerceInvoices.id, id), eq(commerceInvoices.organizationId, organizationId)));
  return invoice ?? null;
}

const quoteActivity =
  (type: 'quote.sent' | 'quote.accepted' | 'quote.declined', verb: string): ActivityProjector =>
  async (tx, event) => {
    const payload = event.payload as EventPayload<'quote.sent'> & { by?: 'customer' | 'staff' };
    const quote = await quoteOf(tx, event.organizationId ?? '', payload.quoteId);
    if (!quote) return null;
    const total = amount(quote.totalMinor, quote.currency);
    return {
      type,
      subject: { type: 'quote', id: quote.id },
      contactId: quote.contactId,
      dealId: quote.dealId,
      summary: `${verb} quote ${quote.number} (${total})`,
      metadata: {
        quoteId: quote.id,
        number: quote.number,
        total,
        ...(payload.by ? { by: payload.by } : {}),
      },
    };
  };

const invoiceActivity =
  (type: 'invoice.sent' | 'invoice.paid', verb: string): ActivityProjector =>
  async (tx, event) => {
    const payload = event.payload as EventPayload<'invoice.sent'>;
    const invoice = await invoiceOf(tx, event.organizationId ?? '', payload.invoiceId);
    if (!invoice?.number) return null;
    const total = amount(BigInt(payload.totalMinor), payload.currency);
    return {
      type,
      subject: { type: 'invoice', id: invoice.id },
      contactId: invoice.contactId,
      dealId: invoice.dealId,
      summary: `${verb} invoice ${invoice.number} (${total})`,
      metadata: { invoiceId: invoice.id, number: invoice.number, total },
    };
  };

/** Quotes and invoices on the contact and deal timeline (visible with `commerce.invoice.read`). */
export const commerceTimelineProjectors: ProjectorMap = {
  'quote.sent': quoteActivity('quote.sent', 'Sent'),
  'quote.accepted': quoteActivity('quote.accepted', 'Accepted'),
  'quote.declined': quoteActivity('quote.declined', 'Declined'),
  'invoice.sent': invoiceActivity('invoice.sent', 'Sent'),
  'invoice.paid': invoiceActivity('invoice.paid', 'Paid'),
};
