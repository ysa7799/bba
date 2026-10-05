import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { crmCompanies, crmContacts, crmDeals } from './crm';
import { organizations } from './organizations';
import { payments } from './payments';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const minor = () => bigint({ mode: 'bigint' }).notNull();
const currency = () => char({ length: 3 }).notNull();

/** Numbering and defaults per organization (one row each, created on first use). */
export const commerceSettings = pgTable(
  'commerce_settings',
  {
    organizationId: uuid()
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoicePrefix: text().notNull().default('INV-'),
    /** Next invoice number: issued invoices are numbered without gaps. */
    nextInvoiceNumber: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    quotePrefix: text().notNull().default('QUO-'),
    nextQuoteNumber: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    defaultDueDays: integer().notNull().default(14),
    /** Printed on every invoice (bank details, VAT registration…). */
    invoiceFooter: text(),
    ...timestamps(),
  },
  (t) => [
    check(
      'commerce_settings_prefix_check',
      sql`char_length(${t.invoicePrefix}) <= 20 and char_length(${t.quotePrefix}) <= 20`,
    ),
    check(
      'commerce_settings_next_check',
      sql`${t.nextInvoiceNumber} >= 1 and ${t.nextQuoteNumber} >= 1`,
    ),
    check('commerce_settings_due_check', sql`${t.defaultDueDays} between 0 and 365`),
    tenantIsolationPolicy(),
  ],
);

/** A tax such as VAT 10%. Rates are kept (archived) because documents refer to them. */
export const commerceTaxRates = pgTable(
  'commerce_tax_rates',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    /** Percent × 100 (10% = 1000). */
    rateBp: integer().notNull(),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('commerce_tax_rates_id_org_unique').on(t.id, t.organizationId),
    check('commerce_tax_rates_rate_check', sql`${t.rateBp} between 0 and 10000`),
    check('commerce_tax_rates_name_check', sql`char_length(${t.name}) between 1 and 60`),
    tenantIsolationPolicy(),
  ],
);

export const PRODUCT_KINDS = ['product', 'service'] as const;

export const commerceProducts = pgTable(
  'commerce_products',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    description: text(),
    sku: text(),
    kind: text({ enum: PRODUCT_KINDS }).notNull().default('service'),
    /** Default tax for new lines (a line can use another). */
    taxRateId: uuid(),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('commerce_products_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_products_sku_unique')
      .on(t.organizationId, sql`lower(${t.sku})`)
      .where(sql`${t.sku} is not null`),
    index('commerce_products_org_idx').on(t.organizationId, t.archivedAt),
    foreignKey({
      name: 'commerce_products_tax_fk',
      columns: [t.taxRateId, t.organizationId],
      foreignColumns: [commerceTaxRates.id, commerceTaxRates.organizationId],
    }),
    check('commerce_products_name_check', sql`char_length(${t.name}) between 1 and 200`),
    check('commerce_products_kind_check', sql`${t.kind} in ('product', 'service')`),
    tenantIsolationPolicy(),
  ],
);

/** A product's price in one currency (one live price per currency). */
export const commerceProductPrices = pgTable(
  'commerce_product_prices',
  {
    id: primaryId(),
    organizationId: orgId(),
    productId: uuid().notNull(),
    currency: currency(),
    unitAmountMinor: minor(),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('commerce_prices_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_prices_live_unique')
      .on(t.productId, t.currency)
      .where(sql`${t.archivedAt} is null`),
    foreignKey({
      name: 'commerce_prices_product_fk',
      columns: [t.productId, t.organizationId],
      foreignColumns: [commerceProducts.id, commerceProducts.organizationId],
    }).onDelete('cascade'),
    check('commerce_prices_amount_check', sql`${t.unitAmountMinor} >= 0`),
    check('commerce_prices_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    tenantIsolationPolicy(),
  ],
);

/** Columns shared by quotes and invoices: customer, currency and server-computed totals. */
const documentColumns = () => ({
  id: primaryId(),
  organizationId: orgId(),
  contactId: uuid().notNull(),
  companyId: uuid(),
  dealId: uuid(),
  currency: currency(),
  notes: text(),
  terms: text(),
  subtotalMinor: minor().default(sql`0`),
  discountMinor: minor().default(sql`0`),
  taxMinor: minor().default(sql`0`),
  totalMinor: minor().default(sql`0`),
  /** SHA-256 of the customer link token (the token itself is never stored). */
  publicTokenHash: text(),
  createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'converted',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const commerceQuotes = pgTable(
  'commerce_quotes',
  {
    ...documentColumns(),
    number: text().notNull(),
    status: text({ enum: QUOTE_STATUSES }).notNull().default('draft'),
    issueDate: date().notNull(),
    validUntil: date(),
    sentAt: timestamp({ withTimezone: true }),
    respondedAt: timestamp({ withTimezone: true }),
    convertedInvoiceId: uuid(),
  },
  (t) => [
    uniqueIndex('commerce_quotes_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_quotes_number_unique').on(t.organizationId, t.number),
    uniqueIndex('commerce_quotes_token_unique').on(t.publicTokenHash),
    index('commerce_quotes_org_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('commerce_quotes_contact_idx').on(t.contactId),
    ...documentForeignKeys('commerce_quotes', t),
    check(
      'commerce_quotes_status_check',
      sql`${t.status} in ('draft', 'sent', 'accepted', 'declined', 'expired', 'converted')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * An invoice. Drafts are editable and unnumbered; issuing assigns the next number and freezes
 * the lines. `amountPaidMinor` is payments applied minus refunds; status follows from it.
 */
export const commerceInvoices = pgTable(
  'commerce_invoices',
  {
    ...documentColumns(),
    number: text(),
    status: text({ enum: INVOICE_STATUSES }).notNull().default('draft'),
    quoteId: uuid(),
    issueDate: date(),
    dueDate: date(),
    amountPaidMinor: minor().default(sql`0`),
    amountRefundedMinor: minor().default(sql`0`),
    sentAt: timestamp({ withTimezone: true }),
    paidAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    /** When `invoice.overdue` was emitted (once per invoice). */
    overdueAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('commerce_invoices_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_invoices_number_unique')
      .on(t.organizationId, t.number)
      .where(sql`${t.number} is not null`),
    uniqueIndex('commerce_invoices_token_unique').on(t.publicTokenHash),
    index('commerce_invoices_org_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('commerce_invoices_contact_idx').on(t.contactId),
    index('commerce_invoices_due_idx')
      .on(t.dueDate)
      .where(sql`${t.status} = 'open' and ${t.overdueAt} is null`),
    ...documentForeignKeys('commerce_invoices', t),
    foreignKey({
      name: 'commerce_invoices_quote_fk',
      columns: [t.quoteId, t.organizationId],
      foreignColumns: [commerceQuotes.id, commerceQuotes.organizationId],
    }),
    check('commerce_invoices_status_check', sql`${t.status} in ('draft', 'open', 'paid', 'void')`),
    check(
      'commerce_invoices_paid_check',
      sql`${t.amountPaidMinor} >= 0 and ${t.amountRefundedMinor} >= 0`,
    ),
    check(
      'commerce_invoices_issued_check',
      sql`${t.status} = 'draft' or (${t.number} is not null and ${t.issueDate} is not null)`,
    ),
    tenantIsolationPolicy(),
  ],
);

function documentForeignKeys(
  table: string,
  t: Record<
    | 'contactId'
    | 'companyId'
    | 'dealId'
    | 'organizationId'
    | 'subtotalMinor'
    | 'discountMinor'
    | 'taxMinor'
    | 'totalMinor'
    | 'currency',
    AnyPgColumn
  >,
) {
  return [
    foreignKey({
      name: `${table}_contact_fk`,
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: `${table}_company_fk`,
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }),
    foreignKey({
      name: `${table}_deal_fk`,
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }),
    check(
      `${table}_amounts_check`,
      sql`${t.subtotalMinor} >= 0 and ${t.discountMinor} >= 0 and ${t.taxMinor} >= 0 and ${t.totalMinor} >= 0`,
    ),
    check(`${table}_currency_check`, sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ];
}

/** Columns of a document line; amounts are computed by the server from quantity and price. */
const lineColumns = () => ({
  id: primaryId(),
  organizationId: orgId(),
  position: integer().notNull(),
  productId: uuid(),
  description: text().notNull(),
  /** Exact decimal (up to 3 places): 1.5 hours, 12 units. */
  quantity: numeric({ precision: 12, scale: 3 }).notNull(),
  unitAmountMinor: minor(),
  /** Line discount, percent × 100. */
  discountBp: integer().notNull().default(0),
  taxRateId: uuid(),
  /** Tax name and rate as they were when the line was saved (documents never change later). */
  taxName: text(),
  taxRateBp: integer().notNull().default(0),
  subtotalMinor: minor(),
  discountMinor: minor(),
  taxMinor: minor(),
  totalMinor: minor(),
});

function lineChecks(
  table: string,
  t: Record<
    'quantity' | 'unitAmountMinor' | 'discountBp' | 'taxRateBp' | 'totalMinor',
    AnyPgColumn
  >,
) {
  return [
    check(`${table}_quantity_check`, sql`${t.quantity} > 0`),
    check(`${table}_unit_check`, sql`${t.unitAmountMinor} >= 0`),
    check(`${table}_discount_check`, sql`${t.discountBp} between 0 and 10000`),
    check(`${table}_tax_check`, sql`${t.taxRateBp} between 0 and 10000`),
    check(`${table}_total_check`, sql`${t.totalMinor} >= 0`),
  ];
}

export const commerceQuoteItems = pgTable(
  'commerce_quote_items',
  { ...lineColumns(), quoteId: uuid().notNull() },
  (t) => [
    index('commerce_quote_items_quote_idx').on(t.quoteId, t.position),
    foreignKey({
      name: 'commerce_quote_items_quote_fk',
      columns: [t.quoteId, t.organizationId],
      foreignColumns: [commerceQuotes.id, commerceQuotes.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'commerce_quote_items_product_fk',
      columns: [t.productId, t.organizationId],
      foreignColumns: [commerceProducts.id, commerceProducts.organizationId],
    }),
    ...lineChecks('commerce_quote_items', t),
    tenantIsolationPolicy(),
  ],
);

export const commerceInvoiceItems = pgTable(
  'commerce_invoice_items',
  { ...lineColumns(), invoiceId: uuid().notNull() },
  (t) => [
    index('commerce_invoice_items_invoice_idx').on(t.invoiceId, t.position),
    foreignKey({
      name: 'commerce_invoice_items_invoice_fk',
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [commerceInvoices.id, commerceInvoices.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'commerce_invoice_items_product_fk',
      columns: [t.productId, t.organizationId],
      foreignColumns: [commerceProducts.id, commerceProducts.organizationId],
    }),
    ...lineChecks('commerce_invoice_items', t),
    tenantIsolationPolicy(),
  ],
);

export const PAYMENT_CONNECTION_STATUSES = [
  'configuration_required',
  'active',
  'disconnected',
] as const;

/**
 * The organization's own payment provider account (customers pay the organization, not
 * BusinessOS). Credentials are sealed. Provider webhooks arrive at a per-connection URL and are
 * authenticated by the provider signature (verified with this connection's credentials).
 */
export const commercePaymentConnections = pgTable(
  'commerce_payment_connections',
  {
    id: primaryId(),
    organizationId: orgId(),
    provider: text().notNull(),
    name: text().notNull(),
    status: text({ enum: PAYMENT_CONNECTION_STATUSES }).notNull(),
    /**
     * SecretBox-sealed JSON credentials, bound to organization + connection id. Never returned
     * by the API. Null until credentials are entered (status `configuration_required`).
     */
    credentialsCiphertext: text(),
    lastError: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('commerce_connections_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_connections_one_live')
      .on(t.organizationId)
      .where(sql`${t.status} <> 'disconnected'`),
    check(
      'commerce_connections_status_check',
      sql`${t.status} in ('configuration_required', 'active', 'disconnected')`,
    ),
    tenantIsolationPolicy(),
  ],
);

/** An online payment attempt for an invoice (the payment row itself is system-written). */
export const commerceCheckouts = pgTable(
  'commerce_checkouts',
  {
    id: primaryId(),
    organizationId: orgId(),
    invoiceId: uuid().notNull(),
    paymentId: uuid().notNull(),
    connectionId: uuid().notNull(),
    redirectUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commerce_checkouts_payment_unique').on(t.paymentId),
    index('commerce_checkouts_invoice_idx').on(t.invoiceId),
    foreignKey({
      name: 'commerce_checkouts_invoice_fk',
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [commerceInvoices.id, commerceInvoices.organizationId],
    }),
    foreignKey({
      name: 'commerce_checkouts_payment_fk',
      columns: [t.paymentId, t.organizationId],
      foreignColumns: [payments.id, payments.organizationId],
    }),
    foreignKey({
      name: 'commerce_checkouts_connection_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [commercePaymentConnections.id, commercePaymentConnections.organizationId],
    }),
    tenantIsolationPolicy(),
  ],
);

export const INVOICE_PAYMENT_SOURCES = ['online', 'manual'] as const;
export const MANUAL_PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'cheque',
  'card_terminal',
  'other',
] as const;

/** Money applied to an invoice: a verified online payment or one recorded by staff. */
export const commerceInvoicePayments = pgTable(
  'commerce_invoice_payments',
  {
    id: primaryId(),
    organizationId: orgId(),
    invoiceId: uuid().notNull(),
    source: text({ enum: INVOICE_PAYMENT_SOURCES }).notNull(),
    /** The verified online payment (unique: a payment is applied once). */
    paymentId: uuid(),
    method: text().notNull(),
    amountMinor: minor(),
    currency: currency(),
    refundedMinor: minor().default(sql`0`),
    reference: text(),
    note: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull(),
    recordedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commerce_invoice_payments_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('commerce_invoice_payments_payment_unique')
      .on(t.paymentId)
      .where(sql`${t.paymentId} is not null`),
    index('commerce_invoice_payments_invoice_idx').on(t.invoiceId, t.receivedAt),
    foreignKey({
      name: 'commerce_invoice_payments_invoice_fk',
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [commerceInvoices.id, commerceInvoices.organizationId],
    }),
    foreignKey({
      name: 'commerce_invoice_payments_payment_fk',
      columns: [t.paymentId, t.organizationId],
      foreignColumns: [payments.id, payments.organizationId],
    }),
    check('commerce_invoice_payments_amount_check', sql`${t.amountMinor} > 0`),
    check(
      'commerce_invoice_payments_refund_check',
      sql`${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor}`,
    ),
    check(
      'commerce_invoice_payments_source_check',
      sql`(${t.source} = 'online') = (${t.paymentId} is not null)`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export const commerceRefunds = pgTable(
  'commerce_refunds',
  {
    id: primaryId(),
    organizationId: orgId(),
    invoiceId: uuid().notNull(),
    invoicePaymentId: uuid().notNull(),
    amountMinor: minor(),
    currency: currency(),
    reason: text().notNull(),
    status: text({ enum: REFUND_STATUSES }).notNull(),
    providerRefundId: text(),
    failureMessage: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('commerce_refunds_invoice_idx').on(t.invoiceId),
    foreignKey({
      name: 'commerce_refunds_invoice_fk',
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [commerceInvoices.id, commerceInvoices.organizationId],
    }),
    foreignKey({
      name: 'commerce_refunds_payment_fk',
      columns: [t.invoicePaymentId, t.organizationId],
      foreignColumns: [commerceInvoicePayments.id, commerceInvoicePayments.organizationId],
    }),
    check('commerce_refunds_amount_check', sql`${t.amountMinor} > 0`),
    check('commerce_refunds_status_check', sql`${t.status} in ('pending', 'succeeded', 'failed')`),
    tenantIsolationPolicy(),
  ],
);

export type CommerceSettings = typeof commerceSettings.$inferSelect;
export type CommerceTaxRate = typeof commerceTaxRates.$inferSelect;
export type CommerceProduct = typeof commerceProducts.$inferSelect;
export type CommerceProductPrice = typeof commerceProductPrices.$inferSelect;
export type CommerceQuote = typeof commerceQuotes.$inferSelect;
export type CommerceInvoice = typeof commerceInvoices.$inferSelect;
export type CommerceLineItem = typeof commerceInvoiceItems.$inferSelect;
export type CommercePaymentConnection = typeof commercePaymentConnections.$inferSelect;
export type CommerceInvoicePayment = typeof commerceInvoicePayments.$inferSelect;
export type CommerceRefund = typeof commerceRefunds.$inferSelect;
