import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy } from './_helpers';
import { crmCompanies, crmContacts, crmDeals } from './crm';
import { organizations } from './organizations';
import { users } from './users';

export const ACTIVITY_ACTOR_TYPES = ['user', 'system', 'api_key', 'workflow', 'contact'] as const;
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

/**
 * The customer timeline: one row per thing that happened, linked to the contact, company and/or
 * deal it concerns. Rows are projected from domain events (idempotent by `source_event_id`) or
 * logged by users. Types, default permissions and exposed metadata keys live in the code
 * registry (`@businessos/activities`); each row stores the permission required to see it,
 * because visibility can depend on the record it hangs off (a note on a deal needs deal access).
 */
export const activities = pgTable(
  'activities',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    category: text().notNull(),
    channel: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actorType: text({ enum: ACTIVITY_ACTOR_TYPES }).notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    contactId: uuid(),
    companyId: uuid(),
    dealId: uuid(),
    /** Permission a member needs to see this row (set by the producer; checked on every read). */
    requiredPermission: text().notNull(),
    summary: text().notNull(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Outbox event this row was projected from (exactly-once projection). */
    sourceEventId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activities_source_event_unique').on(t.sourceEventId),
    index('activities_org_time_idx').on(t.organizationId, t.occurredAt.desc(), t.id.desc()),
    index('activities_contact_time_idx')
      .on(t.contactId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.contactId} is not null`),
    index('activities_company_time_idx')
      .on(t.companyId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.companyId} is not null`),
    index('activities_deal_time_idx')
      .on(t.dealId, t.occurredAt.desc(), t.id.desc())
      .where(sql`${t.dealId} is not null`),
    foreignKey({
      name: 'activities_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'activities_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }),
    foreignKey({
      name: 'activities_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }),
    check('activities_type_check', sql`${t.type} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check('activities_summary_check', sql`char_length(${t.summary}) between 1 and 1000`),
    check(
      'activities_actor_type_check',
      sql`${t.actorType} in ('user', 'system', 'api_key', 'workflow', 'contact')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export type Activity = typeof activities.$inferSelect;
