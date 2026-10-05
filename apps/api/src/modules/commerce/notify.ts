import type { MoneyView } from '@businessos/commerce';
import type { FastifyInstance } from 'fastify';

/** The customer's invoice page (the token is the only credential; never logged). */
export function invoiceLink(app: FastifyInstance, token: string): string {
  return new URL(`/i/${token}`, `${new URL(app.deps.env.APP_URL).origin}/`).toString();
}

export function quoteLink(app: FastifyInstance, token: string): string {
  return new URL(`/q/${token}`, `${new URL(app.deps.env.APP_URL).origin}/`).toString();
}

/**
 * Emails a quote or invoice link to the customer through the `email.send` job (after the change
 * committed). Returns false when the customer has no email address.
 */
export async function emailDocument(
  app: FastifyInstance,
  input: {
    kind: 'quote' | 'invoice';
    documentId: string;
    sentAt: string | null;
    organizationName: string;
    recipient: { name: string; email: string | null };
    number: string;
    total: MoneyView;
    dueDate: string | null;
    link: string;
    correlationId: string;
  },
): Promise<boolean> {
  const to = input.recipient.email;
  if (!to) return false;
  await app.deps.jobs.enqueue(
    'email.send',
    {
      template: input.kind === 'quote' ? 'quote_sent' : 'invoice_sent',
      to,
      locale: 'en',
      data: {
        organization: input.organizationName,
        name: input.recipient.name,
        number: input.number,
        total: `${input.total.currency} ${input.total.amount}`,
        dueDate: input.dueDate ?? '',
        link: input.link,
      },
    },
    {
      jobId: `${input.kind}-sent-${input.documentId}-${Date.parse(input.sentAt ?? '') || 0}`,
      correlationId: input.correlationId,
    },
  );
  return true;
}
