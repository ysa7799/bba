import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { crmContacts } from './crm';
import { organizations } from './organizations';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const CALENDAR_KINDS = ['user', 'resource'] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];

/**
 * A bookable schedule: a member's personal calendar (`user`) or a shared resource such as a
 * room or a team (`resource`). Availability is expressed in the calendar's own time zone.
 */
export const calendars = pgTable(
  'calendars',
  {
    id: primaryId(),
    organizationId: orgId(),
    kind: text({ enum: CALENDAR_KINDS }).notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    name: text().notNull(),
    timezone: text().notNull(),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendars_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('calendars_org_user_unique')
      .on(t.organizationId, t.userId)
      .where(sql`${t.userId} is not null`),
    check('calendars_kind_check', sql`${t.kind} in ('user', 'resource')`),
    check('calendars_name_check', sql`char_length(${t.name}) between 1 and 100`),
    check('calendars_timezone_check', sql`char_length(${t.timezone}) between 1 and 64`),
    tenantIsolationPolicy(),
  ],
);

const calendarFk = (name: string, calendarId: AnyPgColumn, organizationId: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [calendarId, organizationId],
    foreignColumns: [calendars.id, calendars.organizationId],
  });

/** Weekly working hours (`weekday` 0 = Sunday; minutes after local midnight, 0–1440). */
export const calendarAvailabilityRules = pgTable(
  'calendar_availability_rules',
  {
    id: primaryId(),
    organizationId: orgId(),
    calendarId: uuid().notNull(),
    weekday: smallint().notNull(),
    startMinute: integer().notNull(),
    endMinute: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('calendar_availability_rules_calendar_idx').on(t.calendarId, t.weekday),
    calendarFk('calendar_availability_rules_calendar_fk', t.calendarId, t.organizationId).onDelete(
      'cascade',
    ),
    check('calendar_availability_rules_weekday_check', sql`${t.weekday} between 0 and 6`),
    check(
      'calendar_availability_rules_minutes_check',
      sql`${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.startMinute} < ${t.endMinute}`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const AVAILABILITY_EXCEPTION_KINDS = ['available', 'unavailable'] as const;

/**
 * Date overrides in the calendar's zone: `available` replaces that day's weekly hours,
 * `unavailable` removes time (the whole day when minutes are null).
 */
export const calendarAvailabilityExceptions = pgTable(
  'calendar_availability_exceptions',
  {
    id: primaryId(),
    organizationId: orgId(),
    calendarId: uuid().notNull(),
    date: date({ mode: 'string' }).notNull(),
    kind: text({ enum: AVAILABILITY_EXCEPTION_KINDS }).notNull(),
    startMinute: integer(),
    endMinute: integer(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('calendar_availability_exceptions_calendar_idx').on(t.calendarId, t.date),
    calendarFk(
      'calendar_availability_exceptions_calendar_fk',
      t.calendarId,
      t.organizationId,
    ).onDelete('cascade'),
    check(
      'calendar_availability_exceptions_kind_check',
      sql`${t.kind} in ('available', 'unavailable')`,
    ),
    check(
      'calendar_availability_exceptions_minutes_check',
      sql`(${t.startMinute} is null and ${t.endMinute} is null) or (${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.startMinute} < ${t.endMinute})`,
    ),
    check(
      'calendar_availability_exceptions_available_check',
      sql`${t.kind} = 'unavailable' or ${t.startMinute} is not null`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const SCHEDULING_MODES = ['individual', 'round_robin', 'collective'] as const;
export const LOCATION_KINDS = ['in_person', 'phone', 'video', 'custom'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** What can be booked: duration, buffers, booking window, hosts and how they are assigned. */
export const appointmentTypes = pgTable(
  'appointment_types',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    durationMinutes: integer().notNull(),
    bufferBeforeMinutes: integer().notNull().default(0),
    bufferAfterMinutes: integer().notNull().default(0),
    slotIntervalMinutes: integer().notNull().default(30),
    minimumNoticeMinutes: integer().notNull().default(60),
    maximumAdvanceDays: integer().notNull().default(60),
    schedulingMode: text({ enum: SCHEDULING_MODES }).notNull().default('individual'),
    locationKind: text({ enum: LOCATION_KINDS }).notNull().default('in_person'),
    /** Address, phone number or instructions shown to the invitee. */
    locationDetails: text(),
    isActive: boolean().notNull().default(true),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('appointment_types_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('appointment_types_org_slug_unique').on(t.organizationId, t.slug),
    check('appointment_types_name_check', sql`char_length(${t.name}) between 1 and 100`),
    check(
      'appointment_types_slug_check',
      sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'`,
    ),
    check('appointment_types_duration_check', sql`${t.durationMinutes} between 5 and 720`),
    check(
      'appointment_types_buffers_check',
      sql`${t.bufferBeforeMinutes} between 0 and 240 and ${t.bufferAfterMinutes} between 0 and 240`,
    ),
    check('appointment_types_interval_check', sql`${t.slotIntervalMinutes} between 5 and 240`),
    check(
      'appointment_types_window_check',
      sql`${t.minimumNoticeMinutes} between 0 and 43200 and ${t.maximumAdvanceDays} between 1 and 365`,
    ),
    check(
      'appointment_types_mode_check',
      sql`${t.schedulingMode} in ('individual', 'round_robin', 'collective')`,
    ),
    check(
      'appointment_types_location_check',
      sql`${t.locationKind} in ('in_person', 'phone', 'video', 'custom')`,
    ),
    tenantIsolationPolicy(),
  ],
);

/** Calendars that host an appointment type. */
export const appointmentTypeHosts = pgTable(
  'appointment_type_hosts',
  {
    organizationId: orgId(),
    appointmentTypeId: uuid().notNull(),
    calendarId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.appointmentTypeId, t.calendarId] }),
    index('appointment_type_hosts_calendar_idx').on(t.calendarId),
    foreignKey({
      name: 'appointment_type_hosts_type_fk',
      columns: [t.appointmentTypeId, t.organizationId],
      foreignColumns: [appointmentTypes.id, appointmentTypes.organizationId],
    }).onDelete('cascade'),
    calendarFk('appointment_type_hosts_calendar_fk', t.calendarId, t.organizationId).onDelete(
      'cascade',
    ),
    tenantIsolationPolicy(),
  ],
);

/** Public booking page (`/book/<slug>`) offering one or more appointment types. */
export const bookingPages = pgTable(
  'booking_pages',
  {
    id: primaryId(),
    organizationId: orgId(),
    /** Globally unique public slug. */
    slug: text().notNull(),
    title: text().notNull(),
    description: text(),
    isActive: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('booking_pages_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('booking_pages_slug_unique').on(t.slug),
    check('booking_pages_slug_check', sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'`),
    check('booking_pages_title_check', sql`char_length(${t.title}) between 1 and 120`),
    tenantIsolationPolicy(),
  ],
);

export const bookingPageTypes = pgTable(
  'booking_page_types',
  {
    organizationId: orgId(),
    bookingPageId: uuid().notNull(),
    appointmentTypeId: uuid().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bookingPageId, t.appointmentTypeId] }),
    index('booking_page_types_type_idx').on(t.appointmentTypeId),
    foreignKey({
      name: 'booking_page_types_page_fk',
      columns: [t.bookingPageId, t.organizationId],
      foreignColumns: [bookingPages.id, bookingPages.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'booking_page_types_type_fk',
      columns: [t.appointmentTypeId, t.organizationId],
      foreignColumns: [appointmentTypes.id, appointmentTypes.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const APPOINTMENT_STATUSES = ['scheduled', 'cancelled', 'completed', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_SOURCES = ['booking_page', 'staff'] as const;

/**
 * A booked meeting. Its time on each host calendar is held by `calendar_busy_blocks`, whose
 * exclusion constraint makes double booking impossible even under concurrent requests.
 */
export const appointments = pgTable(
  'appointments',
  {
    id: primaryId(),
    organizationId: orgId(),
    appointmentTypeId: uuid(),
    /** Primary host calendar (the assigned host; first host for collective bookings). */
    calendarId: uuid().notNull(),
    contactId: uuid(),
    bookingPageId: uuid(),
    title: text().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    bufferBeforeMinutes: integer().notNull().default(0),
    bufferAfterMinutes: integer().notNull().default(0),
    status: text({ enum: APPOINTMENT_STATUSES }).notNull().default('scheduled'),
    source: text({ enum: APPOINTMENT_SOURCES }).notNull(),
    locationKind: text({ enum: LOCATION_KINDS }).notNull().default('in_person'),
    locationDetails: text(),
    joinUrl: text(),
    /** Invitee's zone for messages (display only; times are stored in UTC). */
    timezone: text().notNull(),
    inviteeName: text(),
    inviteeEmail: text(),
    inviteePhone: text(),
    inviteeNotes: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: text(),
    cancellationReason: text(),
    reminderSentAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('appointments_id_org_unique').on(t.id, t.organizationId),
    index('appointments_org_starts_idx').on(t.organizationId, t.startsAt, t.id),
    index('appointments_calendar_starts_idx').on(t.calendarId, t.startsAt),
    index('appointments_contact_idx').on(t.contactId),
    index('appointments_reminder_idx')
      .on(t.startsAt)
      .where(sql`${t.status} = 'scheduled' and ${t.reminderSentAt} is null`),
    foreignKey({
      name: 'appointments_type_fk',
      columns: [t.appointmentTypeId, t.organizationId],
      foreignColumns: [appointmentTypes.id, appointmentTypes.organizationId],
    }),
    calendarFk('appointments_calendar_fk', t.calendarId, t.organizationId),
    foreignKey({
      name: 'appointments_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'appointments_booking_page_fk',
      columns: [t.bookingPageId, t.organizationId],
      foreignColumns: [bookingPages.id, bookingPages.organizationId],
    }),
    check('appointments_time_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('appointments_title_check', sql`char_length(${t.title}) between 1 and 200`),
    check(
      'appointments_status_check',
      sql`${t.status} in ('scheduled', 'cancelled', 'completed', 'no_show')`,
    ),
    check('appointments_source_check', sql`${t.source} in ('booking_page', 'staff')`),
    check(
      'appointments_location_check',
      sql`${t.locationKind} in ('in_person', 'phone', 'video', 'custom')`,
    ),
    check(
      'appointments_buffers_check',
      sql`${t.bufferBeforeMinutes} between 0 and 240 and ${t.bufferAfterMinutes} between 0 and 240`,
    ),
    check(
      'appointments_cancelled_by_check',
      sql`${t.cancelledBy} is null or ${t.cancelledBy} in ('invitee', 'staff')`,
    ),
    tenantIsolationPolicy(),
  ],
);

/**
 * Links that let the invitee view, cancel or reschedule without an account. Only a SHA-256 hash
 * is stored; each email (confirmation, reminder) carries its own token.
 */
export const appointmentManageTokens = pgTable(
  'appointment_manage_tokens',
  {
    id: primaryId(),
    organizationId: orgId(),
    appointmentId: uuid().notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('appointment_manage_tokens_hash_unique').on(t.tokenHash),
    index('appointment_manage_tokens_appointment_idx').on(t.appointmentId),
    foreignKey({
      name: 'appointment_manage_tokens_appointment_fk',
      columns: [t.appointmentId, t.organizationId],
      foreignColumns: [appointments.id, appointments.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const PARTICIPANT_ROLES = ['host', 'invitee', 'guest'] as const;

/** Who attends: host calendars (and their members), the invitee and extra guests. */
export const appointmentParticipants = pgTable(
  'appointment_participants',
  {
    id: primaryId(),
    organizationId: orgId(),
    appointmentId: uuid().notNull(),
    role: text({ enum: PARTICIPANT_ROLES }).notNull(),
    calendarId: uuid(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    contactId: uuid(),
    name: text(),
    email: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointment_participants_appointment_idx').on(t.appointmentId),
    index('appointment_participants_user_idx').on(t.userId),
    foreignKey({
      name: 'appointment_participants_appointment_fk',
      columns: [t.appointmentId, t.organizationId],
      foreignColumns: [appointments.id, appointments.organizationId],
    }).onDelete('cascade'),
    calendarFk('appointment_participants_calendar_fk', t.calendarId, t.organizationId),
    foreignKey({
      name: 'appointment_participants_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    check('appointment_participants_role_check', sql`${t.role} in ('host', 'invitee', 'guest')`),
    tenantIsolationPolicy(),
  ],
);

/**
 * Time held on a host calendar by a scheduled appointment, including its buffers. A
 * hand-written exclusion constraint (migration 0022) forbids two overlapping blocks on the same
 * calendar: the database, not application checks, is what prevents double booking.
 */
export const calendarBusyBlocks = pgTable(
  'calendar_busy_blocks',
  {
    id: primaryId(),
    organizationId: orgId(),
    calendarId: uuid().notNull(),
    appointmentId: uuid().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('calendar_busy_blocks_appointment_calendar_unique').on(
      t.appointmentId,
      t.calendarId,
    ),
    index('calendar_busy_blocks_calendar_idx').on(t.calendarId, t.startsAt),
    calendarFk('calendar_busy_blocks_calendar_fk', t.calendarId, t.organizationId).onDelete(
      'cascade',
    ),
    foreignKey({
      name: 'calendar_busy_blocks_appointment_fk',
      columns: [t.appointmentId, t.organizationId],
      foreignColumns: [appointments.id, appointments.organizationId],
    }).onDelete('cascade'),
    check('calendar_busy_blocks_time_check', sql`${t.endsAt} > ${t.startsAt}`),
    tenantIsolationPolicy(),
  ],
);

export const CALENDAR_CONNECTION_STATUSES = [
  'active',
  'configuration_required',
  'error',
  'disconnected',
] as const;

/**
 * An external calendar (Google, Microsoft 365) linked to a calendar: its busy times block
 * availability and bookings can be mirrored to it. Credentials are sealed like channel
 * credentials and never returned by the API.
 */
export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: primaryId(),
    organizationId: orgId(),
    calendarId: uuid().notNull(),
    provider: text().notNull(),
    externalCalendarId: text().notNull(),
    status: text({ enum: CALENDAR_CONNECTION_STATUSES })
      .notNull()
      .default('configuration_required'),
    credentialsCiphertext: text(),
    /** Read busy times into availability. */
    checkConflicts: boolean().notNull().default(true),
    /** Create events for new bookings. */
    writeEvents: boolean().notNull().default(true),
    lastSyncedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_connections_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('calendar_connections_calendar_provider_unique')
      .on(t.calendarId, t.provider)
      .where(sql`${t.status} <> 'disconnected'`),
    calendarFk('calendar_connections_calendar_fk', t.calendarId, t.organizationId).onDelete(
      'cascade',
    ),
    check('calendar_connections_provider_check', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check(
      'calendar_connections_status_check',
      sql`${t.status} in ('active', 'configuration_required', 'error', 'disconnected')`,
    ),
    tenantIsolationPolicy(),
  ],
);

/** External events created for an appointment (one per writing connection). */
export const appointmentExternalEvents = pgTable(
  'appointment_external_events',
  {
    id: primaryId(),
    organizationId: orgId(),
    appointmentId: uuid().notNull(),
    connectionId: uuid().notNull(),
    externalEventId: text(),
    /** Start time the external event was created for (a reschedule recreates it). */
    syncedStartsAt: timestamp({ withTimezone: true }),
    status: text().notNull().default('pending'),
    lastError: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('appointment_external_events_unique').on(t.appointmentId, t.connectionId),
    foreignKey({
      name: 'appointment_external_events_appointment_fk',
      columns: [t.appointmentId, t.organizationId],
      foreignColumns: [appointments.id, appointments.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'appointment_external_events_connection_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [calendarConnections.id, calendarConnections.organizationId],
    }).onDelete('cascade'),
    check(
      'appointment_external_events_status_check',
      sql`${t.status} in ('pending', 'created', 'cancelled', 'failed')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export type Calendar = typeof calendars.$inferSelect;
export type AppointmentType = typeof appointmentTypes.$inferSelect;
export type BookingPage = typeof bookingPages.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type CalendarConnection = typeof calendarConnections.$inferSelect;
