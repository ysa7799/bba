import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import { planVersions, prices } from './billing';
import { organizations } from './organizations';
import { users } from './users';

export const PAYMENT_STATUSES = [
  'pending',
  'requires_action',
  'authorized',
  'captured',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PURPOSES = ['subscription', 'invoice'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/**
 * A payment attempt with one provider. Status changes only through server-side verification
 * (provider API) or authenticated webhooks; tenants can read but never write payment rows.
 */
export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purpose: text({ enum: PAYMENT_PURPOSES }).notNull(),
    provider: text().notNull(),
    providerPaymentId: text(),
    amountMinor: bigint({ mode: 'bigint' }).notNull(),
    currency: char({ length: 3 }).notNull(),
    status: text({ enum: PAYMENT_STATUSES }).notNull().default('pending'),
    method: text(),
    refundedAmountMinor: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    failureCode: text(),
    failureMessage: text(),
    capturedAt: timestamp({ withTimezone: true }),
    lastVerifiedAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('payments_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('payments_provider_ref_unique')
      .on(t.provider, t.providerPaymentId)
      .where(sql`${t.providerPaymentId} is not null`),
    index('payments_org_created_idx').on(t.organizationId, t.createdAt),
    check('payments_amount_check', sql`${t.amountMinor} > 0`),
    check('payments_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'payments_refund_bounds_check',
      sql`${t.refundedAmountMinor} >= 0 AND ${t.refundedAmountMinor} <= ${t.amountMinor}`,
    ),
    check(
      'payments_status_check',
      sql`${t.status} in ('pending', 'requires_action', 'authorized', 'captured', 'failed', 'canceled', 'partially_refunded', 'refunded')`,
    ),
    pgPolicy('tenant_read', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system() OR organization_id = app_current_org()`,
    }),
    pgPolicy('system_write', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export const CHECKOUT_STATUSES = ['open', 'completed', 'failed', 'expired'] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

/** A subscription checkout: what the organization is buying, priced server-side. */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id, { onDelete: 'restrict' }),
    priceId: uuid()
      .notNull()
      .references(() => prices.id, { onDelete: 'restrict' }),
    paymentId: uuid().notNull(),
    status: text({ enum: CHECKOUT_STATUSES }).notNull().default('open'),
    redirectUrl: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    completedAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'checkout_sessions_payment_fk',
      columns: [t.paymentId, t.organizationId],
      foreignColumns: [payments.id, payments.organizationId],
    }).onDelete('restrict'),
    uniqueIndex('checkout_sessions_payment_unique').on(t.paymentId),
    index('checkout_sessions_org_created_idx').on(t.organizationId, t.createdAt),
    check(
      'checkout_sessions_status_check',
      sql`${t.status} in ('open', 'completed', 'failed', 'expired')`,
    ),
    pgPolicy('tenant_read', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system() OR organization_id = app_current_org()`,
    }),
    pgPolicy('system_write', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export const WEBHOOK_EVENT_STATUSES = [
  'received',
  'processed',
  'ignored',
  'rejected',
  'failed',
] as const;

/**
 * Every inbound provider webhook (valid or not) for diagnostics, replay protection and
 * idempotency. `(provider, provider_event_id)` is unique.
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: primaryId(),
    provider: text().notNull(),
    providerEventId: text().notNull(),
    signatureValid: boolean().notNull(),
    status: text({ enum: WEBHOOK_EVENT_STATUSES }).notNull().default('received'),
    providerPaymentId: text(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    /** Redacted payload summary for diagnostics. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('payment_webhook_events_provider_event_unique').on(t.provider, t.providerEventId),
    index('payment_webhook_events_received_idx').on(t.receivedAt),
    pgPolicy('system_only', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
