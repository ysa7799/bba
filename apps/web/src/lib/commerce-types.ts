// Response shapes of the commerce API (`/app/orgs/:orgId/commerce/*`, `/public/commerce/*`).
// Amounts are exact decimal strings with their minor units; the API computes every total.

export interface Money {
  amountMinor: string;
  amount: string;
  currency: string;
}

export interface TaxRate {
  id: string;
  name: string;
  percent: string;
  archived: boolean;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  kind: 'product' | 'service';
  taxRate: TaxRate | null;
  archived: boolean;
  prices: { id: string; currency: string; unitAmount: Money }[];
}

export interface DocumentLine {
  id: string;
  position: number;
  productId: string | null;
  description: string;
  quantity: string;
  unitAmount: Money;
  discountPercent: string;
  tax: { id: string | null; name: string; percent: string } | null;
  subtotal: Money;
  discount: Money;
  taxAmount: Money;
  total: Money;
}

interface Parties {
  contact: { id: string; name: string; email: string | null } | null;
  company: { id: string; name: string } | null;
}

interface Totals {
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void';
export const INVOICE_FILTERS = ['all', 'draft', 'open', 'overdue', 'paid', 'void'] as const;

export interface InvoiceSummary extends Parties, Totals {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  overdue: boolean;
  currency: string;
  dealId: string | null;
  quoteId: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amountPaid: Money;
  amountDue: Money;
  amountOverpaid: Money;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface InvoiceDetail extends InvoiceSummary {
  notes: string | null;
  terms: string | null;
  lines: DocumentLine[];
  payments: {
    id: string;
    source: 'online' | 'manual';
    method: string;
    amount: Money;
    refunded: Money;
    /** What can still be refunded from this payment (computed by the API). */
    refundable: Money;
    reference: string | null;
    note: string | null;
    receivedAt: string;
  }[];
  refunds: {
    id: string;
    invoicePaymentId: string;
    amount: Money;
    reason: string;
    status: 'pending' | 'succeeded' | 'failed';
    createdAt: string;
  }[];
  attempts: { paymentId: string; status: string; amount: Money; createdAt: string }[];
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';
export const QUOTE_FILTERS = [
  'all',
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'converted',
] as const;

export interface QuoteSummary extends Parties, Totals {
  id: string;
  number: string;
  status: QuoteStatus;
  currency: string;
  dealId: string | null;
  issueDate: string;
  validUntil: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  convertedInvoiceId: string | null;
  createdAt: string;
}

export interface QuoteDetail extends QuoteSummary {
  notes: string | null;
  terms: string | null;
  lines: DocumentLine[];
}

export interface CommerceSettings {
  invoicePrefix: string;
  quotePrefix: string;
  nextInvoiceNumber: number;
  nextQuoteNumber: number;
  defaultDueDays: number;
  invoiceFooter: string | null;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
}

export interface PaymentConnection {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  status: 'configuration_required' | 'active' | 'disconnected';
  configuredFields: string[];
  credentialFields: CredentialField[];
  webhookUrl: string;
  lastError: string | null;
  createdAt: string;
}

export const MANUAL_PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'card_terminal',
  'other',
] as const;

/** What a customer sees on their invoice link. */
export interface PublicInvoiceView {
  organization: { name: string };
  payable: boolean;
  invoice: Totals & {
    number: string;
    status: InvoiceStatus;
    overdue: boolean;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    customer: string;
    notes: string | null;
    terms: string | null;
    footer: string | null;
    lines: DocumentLine[];
    amountPaid: Money;
    amountDue: Money;
  };
}

export interface PublicQuoteView {
  organization: { name: string };
  quote: Totals & {
    number: string;
    status: QuoteStatus;
    canRespond: boolean;
    issueDate: string;
    validUntil: string | null;
    currency: string;
    customer: string;
    notes: string | null;
    terms: string | null;
    footer: string | null;
    lines: DocumentLine[];
  };
}
