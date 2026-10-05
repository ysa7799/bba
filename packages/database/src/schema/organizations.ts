import { sql } from 'drizzle-orm';
import {
  check,
  char,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { users } from './users';

export const ORGANIZATION_STATUSES = ['active', 'suspended', 'cancelled'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** The tenant. */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryId(),
    name: text().notNull(),
    /** Globally unique, URL-safe handle (future subdomains / white-label routing). */
    slug: text().notNull(),
    /** ISO 3166-1 alpha-2. */
    countryCode: char({ length: 2 }).notNull().default('BH'),
    /** ISO 4217; explicit — never assume USD. */
    defaultCurrency: char({ length: 3 }).notNull().default('BHD'),
    /** IANA timezone. */
    timezone: text().notNull().default('Asia/Bahrain'),
    locale: text().notNull().default('en'),
    status: text({ enum: ORGANIZATION_STATUSES }).notNull().default('active'),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organizations_slug_unique').on(t.slug),
    check('organizations_status_check', sql`${t.status} in ('active', 'suspended', 'cancelled')`),
    check(
      'organizations_slug_format_check',
      sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'`,
    ),
    check('organizations_name_length_check', sql`char_length(${t.name}) between 1 and 200`),
    check('organizations_country_check', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check('organizations_currency_check', sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    // Visible inside its own tenant context, or system. In user scope (no organization set) a
    // user sees the organizations they actively belong to (organization switcher). The user
    // clause is disabled inside a tenant context so tenant queries never return other tenants.
    pgPolicy('organizations_select', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system()
        OR ${t.id} = app_current_org()
        OR (app_current_org() IS NULL AND ${t.id} IN (
          SELECT m.organization_id FROM memberships m
          WHERE m.user_id = app_current_user() AND m.status = 'active'
        ))`,
    }),
    pgPolicy('organizations_modify', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system() OR ${t.id} = app_current_org()`,
      withCheck: sql`app_is_system() OR ${t.id} = app_current_org()`,
    }),
  ],
);

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** A user's membership in an organization. Roles are attached in the RBAC phase. */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId),
    // Target for composite foreign keys that guarantee same-tenant references.
    uniqueIndex('memberships_id_org_unique').on(t.id, t.organizationId),
    index('memberships_user_idx').on(t.userId),
    check('memberships_status_check', sql`${t.status} in ('active', 'suspended')`),
    // Members are visible inside the tenant. In user scope (no organization set) a user may
    // read their own memberships across organizations. Writes require tenant or system scope.
    pgPolicy('memberships_select', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system()
        OR ${t.organizationId} = app_current_org()
        OR (app_current_org() IS NULL AND ${t.userId} = app_current_user())`,
    }),
    pgPolicy('memberships_insert', {
      as: 'permissive',
      for: 'insert',
      withCheck: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
    pgPolicy('memberships_update', {
      as: 'permissive',
      for: 'update',
      using: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
      withCheck: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
    pgPolicy('memberships_delete', {
      as: 'permissive',
      for: 'delete',
      using: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
  ],
);

/**
 * Typed key/value organization settings. Keys and value schemas are defined in code
 * (`@businessos/organizations` settings registry); unknown keys are rejected there.
 */
export const organizationSettings = pgTable(
  'organization_settings',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: jsonb().notNull(),
    updatedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('organization_settings_org_key_unique').on(t.organizationId, t.key),
    check('organization_settings_key_format_check', sql`${t.key} ~ '^[a-z][a-z0-9_.]{1,99}$'`),
    tenantIsolationPolicy(),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type OrganizationSetting = typeof organizationSettings.$inferSelect;
