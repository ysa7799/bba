import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import { organizations } from './organizations';
import { users } from './users';

/** Platform catalogue: readable from any scope, writable only in system scope. */
function catalogPolicies() {
  return [
    pgPolicy('catalog_read', { as: 'permissive', for: 'select', using: sql`true` }),
    pgPolicy('catalog_write', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ];
}

/**
 * Tenant-owned billing state that tenants may read but never write: changes come only from
 * system paths (verified payment webhooks, platform administration).
 */
function tenantReadOnlyPolicies() {
  return [
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
  ];
}

function tenantReadWritePolicy() {
  return pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    using: sql`app_is_system() OR organization_id = app_current_org()`,
    withCheck: sql`app_is_system() OR organization_id = app_current_org()`,
  });
}

export const plans = pgTable(
  'plans',
  {
    id: primaryId(),
    /** Stable identifier for operators. Code never branches on it (entitlements only). */
    key: text().notNull(),
    name: text().notNull(),
    description: text().notNull().default(''),
    status: text({ enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    isPublic: boolean().notNull().default(true),
    /** New organizations are subscribed to the default plan. At most one. */
    isDefault: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('plans_key_unique').on(t.key),
    uniqueIndex('plans_single_default')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    check('plans_key_format_check', sql`${t.key} ~ '^[a-z0-9][a-z0-9_-]{1,62}$'`),
    check('plans_status_check', sql`${t.status} in ('active', 'archived')`),
    ...catalogPolicies(),
  ],
);

/**
 * Entitlements and prices hang off a plan version, so editing a plan never silently changes
 * what existing subscribers get; they move versions explicitly.
 */
export const planVersions = pgTable(
  'plan_versions',
  {
    id: primaryId(),
    planId: uuid()
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    status: text({ enum: ['draft', 'published', 'retired'] })
      .notNull()
      .default('draft'),
    publishedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('plan_versions_plan_version_unique').on(t.planId, t.version),
    check('plan_versions_status_check', sql`${t.status} in ('draft', 'published', 'retired')`),
    check('plan_versions_version_check', sql`${t.version} >= 1`),
    ...catalogPolicies(),
  ],
);

export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    /** Validated against the entitlement registry: boolean for features, number|null for limits. */
    value: jsonb().notNull(),
  },
  (t) => [primaryKey({ columns: [t.planVersionId, t.key] }), ...catalogPolicies()],
);

export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const prices = pgTable(
  'prices',
  {
    id: primaryId(),
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id, { onDelete: 'restrict' }),
    currency: char({ length: 3 }).notNull(),
    interval: text({ enum: BILLING_INTERVALS }).notNull(),
    amountMinor: bigint({ mode: 'bigint' }).notNull(),
    status: text({ enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('prices_version_currency_interval_unique')
      .on(t.planVersionId, t.currency, t.interval)
      .where(sql`${t.status} = 'active'`),
    check('prices_amount_check', sql`${t.amountMinor} >= 0`),
    check('prices_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('prices_interval_check', sql`${t.interval} in ('month', 'year')`),
    ...catalogPolicies(),
  ],
);

/** Billing profile of an organization (used on invoices and by payment providers). */
export const billingCustomers = pgTable(
  'billing_customers',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    legalName: text().notNull(),
    billingEmail: text().notNull(),
    /** VAT / tax registration number, if any. */
    taxId: text(),
    countryCode: char({ length: 2 }).notNull(),
    addressLine1: text(),
    addressLine2: text(),
    city: text(),
    postalCode: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('billing_customers_org_unique').on(t.organizationId),
    check(
      'billing_customers_email_check',
      sql`${t.billingEmail} = lower(btrim(${t.billingEmail}))`,
    ),
    tenantReadWritePolicy(),
  ],
);

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'incomplete',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planVersionId: uuid()
      .notNull()
      .references(() => planVersions.id, { onDelete: 'restrict' }),
    status: text({ enum: SUBSCRIPTION_STATUSES }).notNull(),
    /** `manual` for free/admin-managed subscriptions; payment providers from Phase 7. */
    provider: text().notNull().default('manual'),
    providerSubscriptionId: text(),
    currentPeriodStart: timestamp({ withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp({ withTimezone: true }),
    trialEndsAt: timestamp({ withTimezone: true }),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    canceledAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // One live subscription per organization.
    uniqueIndex('subscriptions_one_live_per_org')
      .on(t.organizationId)
      .where(sql`${t.status} <> 'canceled'`),
    uniqueIndex('subscriptions_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('subscriptions_provider_ref_unique')
      .on(t.provider, t.providerSubscriptionId)
      .where(sql`${t.providerSubscriptionId} is not null`),
    check(
      'subscriptions_status_check',
      sql`${t.status} in ('trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete')`,
    ),
    ...tenantReadOnlyPolicies(),
  ],
);

export const subscriptionItems = pgTable(
  'subscription_items',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subscriptionId: uuid().notNull(),
    priceId: uuid()
      .notNull()
      .references(() => prices.id, { onDelete: 'restrict' }),
    quantity: integer().notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'subscription_items_subscription_fk',
      columns: [t.subscriptionId, t.organizationId],
      foreignColumns: [subscriptions.id, subscriptions.organizationId],
    }).onDelete('cascade'),
    index('subscription_items_subscription_idx').on(t.subscriptionId),
    check('subscription_items_quantity_check', sql`${t.quantity} >= 1`),
    ...tenantReadOnlyPolicies(),
  ],
);

/** Per-organization entitlement overrides granted by platform administrators. */
export const entitlementOverrides = pgTable(
  'entitlement_overrides',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: jsonb().notNull(),
    reason: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('entitlement_overrides_org_key_unique').on(t.organizationId, t.key),
    check('entitlement_overrides_reason_check', sql`char_length(${t.reason}) between 3 and 500`),
    ...tenantReadOnlyPolicies(),
  ],
);

/**
 * Aggregated usage per metric and period (calendar month in the organization's timezone).
 * Quota consumption is a single conditional UPDATE, so concurrent requests cannot overshoot.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    metric: text().notNull(),
    periodStart: date({ mode: 'string' }).notNull(),
    used: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.metric, t.periodStart] }),
    check('usage_counters_used_check', sql`${t.used} >= 0`),
    tenantReadWritePolicy(),
  ],
);

/** Individual usage events (idempotent per organization + key) for audit and reconciliation. */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    metric: text().notNull(),
    periodStart: date({ mode: 'string' }).notNull(),
    quantity: bigint({ mode: 'bigint' }).notNull(),
    idempotencyKey: text(),
    source: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_records_idempotency_unique')
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index('usage_records_org_metric_period_idx').on(t.organizationId, t.metric, t.periodStart),
    check('usage_records_quantity_check', sql`${t.quantity} > 0`),
    tenantReadWritePolicy(),
  ],
);

/** Billing history (subscription lifecycle now; normalized provider events from Phase 7). */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: primaryId(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('billing_events_org_idx').on(t.organizationId, t.occurredAt),
    ...tenantReadOnlyPolicies(),
  ],
);

export type Plan = typeof plans.$inferSelect;
export type PlanVersion = typeof planVersions.$inferSelect;
export type Price = typeof prices.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type BillingCustomer = typeof billingCustomers.$inferSelect;
