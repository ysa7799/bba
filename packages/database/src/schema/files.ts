import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { organizations } from './organizations';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const FILE_STATUSES = ['pending', 'ready', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
export const FILE_ENTITY_TYPES = ['contact', 'company', 'deal'] as const;
export type FileEntityType = (typeof FILE_ENTITY_TYPES)[number];

/**
 * An uploaded file. The bytes live in object storage under `storage_key`; this row is the
 * source of truth for ownership, type (sniffed, never taken from the client), size (counted
 * against `storage.bytes`) and the record it is attached to.
 */
export const files = pgTable(
  'files',
  {
    id: primaryId(),
    organizationId: orgId(),
    /** The record the file is attached to (validated to belong to the organization). */
    entityType: text({ enum: FILE_ENTITY_TYPES }),
    entityId: uuid(),
    /** Sanitized display name (no path, no control characters). */
    name: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: 'bigint' }).notNull(),
    sha256: text().notNull(),
    storageKey: text().notNull(),
    status: text({ enum: FILE_STATUSES }).notNull().default('pending'),
    uploadedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp({ withTimezone: true }),
    /** When the stored object was removed after deletion (maintenance retries until set). */
    purgedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('files_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('files_storage_key_unique').on(t.storageKey),
    index('files_entity_idx')
      .on(t.organizationId, t.entityType, t.entityId, t.createdAt.desc())
      .where(sql`${t.status} = 'ready'`),
    index('files_cleanup_idx').on(t.status, t.updatedAt),
    check('files_size_check', sql`${t.sizeBytes} > 0`),
    check('files_status_check', sql`${t.status} in ('pending', 'ready', 'deleted')`),
    check(
      'files_entity_check',
      sql`(${t.entityType} is null) = (${t.entityId} is null) and (${t.entityType} is null or ${t.entityType} in ('contact', 'company', 'deal'))`,
    ),
    check('files_name_check', sql`char_length(${t.name}) between 1 and 200`),
    tenantIsolationPolicy(),
  ],
);

/**
 * A notification for one member. Readable and changeable only by that member (and the
 * platform): the organization scope alone is not enough.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    organizationId: orgId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    title: text().notNull(),
    body: text(),
    /** In-app path to open (relative, validated). */
    link: text(),
    subjectType: text(),
    subjectId: uuid(),
    /** The domain event that caused it: one notification per member, type and event. */
    sourceEventId: uuid().notNull(),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notifications_event_unique').on(t.userId, t.type, t.sourceEventId),
    index('notifications_user_idx').on(t.organizationId, t.userId, t.createdAt.desc(), t.id.desc()),
    index('notifications_unread_idx')
      .on(t.organizationId, t.userId)
      .where(sql`${t.readAt} is null`),
    // Retention sweeps (worker) across organizations by age.
    index('notifications_created_idx').on(t.createdAt),
    check('notifications_title_check', sql`char_length(${t.title}) between 1 and 300`),
    check('notifications_link_check', sql`${t.link} is null or ${t.link} ~ '^/o/[0-9a-f-]{36}/'`),
    pgPolicy('notifications_owner', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())`,
      withCheck: sql`app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())`,
    }),
  ],
);

/** A member's choice of channels per notification type (absent: the type's defaults). */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    organizationId: orgId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    inApp: boolean().notNull(),
    email: boolean().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId, t.type] }),
    pgPolicy('notification_preferences_owner', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())`,
      withCheck: sql`app_is_system() OR (organization_id = app_current_org() AND user_id = app_current_user())`,
    }),
  ],
);

export type FileRecord = typeof files.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;
