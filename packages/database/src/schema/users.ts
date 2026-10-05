import { sql } from 'drizzle-orm';
import { check, index, pgPolicy, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Global identity table (not tenant-owned). Visible to: system context, the user themself, and
 * tenant contexts for users who are members of that organization.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    /** Normalized (trimmed, lower-cased) email address. */
    email: text().notNull(),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    /** argon2id hash; null for accounts that only use external identity providers. */
    passwordHash: text(),
    name: text().notNull(),
    locale: text().notNull().default('en'),
    timezone: text().notNull().default('Asia/Bahrain'),
    status: text({ enum: USER_STATUSES }).notNull().default('active'),
    lastLoginAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('users_created_at_idx').on(t.createdAt),
    check('users_status_check', sql`${t.status} in ('active', 'disabled')`),
    check('users_email_normalized_check', sql`${t.email} = lower(btrim(${t.email}))`),
    check('users_name_length_check', sql`char_length(${t.name}) between 1 and 200`),
    pgPolicy('users_select', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system()
        OR ${t.id} = app_current_user()
        OR ${t.id} IN (
          SELECT m.user_id FROM memberships m WHERE m.organization_id = app_current_org()
        )`,
    }),
    pgPolicy('users_modify', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system() OR ${t.id} = app_current_user()`,
      withCheck: sql`app_is_system() OR ${t.id} = app_current_user()`,
    }),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
