import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId } from './_helpers';
import { organizations } from './organizations';
import { users } from './users';

export const AUDIT_ACTOR_TYPES = ['user', 'api_key', 'system', 'platform_admin'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Append-only audit trail. There are deliberately no UPDATE or DELETE policies: with forced RLS
 * no application role can modify or remove audit records. `organization_id` is null for
 * account-level security events (sign-in, password changes).
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: text({ enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Snapshot of the actor's label (e.g. email) at the time of the action. */
    actorLabel: text(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    /** Safe, redacted context. Never secrets. */
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: inet(),
    userAgent: text(),
    requestId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_org_action_idx').on(t.organizationId, t.action, t.createdAt),
    check('audit_logs_action_format_check', sql`${t.action} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check(
      'audit_logs_actor_type_check',
      sql`${t.actorType} in ('user', 'api_key', 'system', 'platform_admin')`,
    ),
    pgPolicy('audit_logs_select', {
      as: 'permissive',
      for: 'select',
      using: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
    pgPolicy('audit_logs_insert', {
      as: 'permissive',
      for: 'insert',
      withCheck: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
  ],
);

export const OUTBOX_STATUSES = ['pending', 'processing', 'dispatched', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Transactional outbox for domain events (ADR-010). Rows are inserted in the same transaction
 * as the state change; the worker's dispatcher claims them with SKIP LOCKED and fans them out
 * to subscribers as jobs. Tenant code may insert; only system scope reads/updates.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    /** Event id (UUIDv7); consumers use it as their idempotency key. */
    id: primaryId(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    version: integer().notNull(),
    subjectType: text().notNull(),
    subjectId: text().notNull(),
    actorType: text().notNull(),
    actorId: text(),
    correlationId: text(),
    causationId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    status: text({ enum: OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp({ withTimezone: true }),
    dispatchedAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.availableAt, t.id)
      .where(sql`${t.status} in ('pending', 'processing')`),
    index('outbox_events_org_occurred_idx').on(t.organizationId, t.occurredAt),
    check('outbox_events_type_format_check', sql`${t.type} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check(
      'outbox_events_status_check',
      sql`${t.status} in ('pending', 'processing', 'dispatched', 'failed')`,
    ),
    pgPolicy('outbox_events_insert', {
      as: 'permissive',
      for: 'insert',
      withCheck: sql`app_is_system() OR ${t.organizationId} = app_current_org()`,
    }),
    pgPolicy('outbox_events_system', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

/** Records which subscriber has processed which event (strict consumer idempotency). */
export const processedEvents = pgTable(
  'processed_events',
  {
    subscriber: text().notNull(),
    eventId: uuid().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.subscriber, t.eventId] }),
    pgPolicy('processed_events_system', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

/** Durable dead-letter record of jobs that exhausted their retries. */
export const jobFailures = pgTable(
  'job_failures',
  {
    id: primaryId(),
    queue: text().notNull(),
    jobName: text().notNull(),
    jobId: text(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    correlationId: text(),
    attempts: integer().notNull(),
    error: text().notNull(),
    /** Redacted payload for diagnostics. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    failedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('job_failures_failed_at_idx').on(t.failedAt),
    index('job_failures_org_idx').on(t.organizationId, t.failedAt),
    pgPolicy('job_failures_system', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type JobFailure = typeof jobFailures.$inferSelect;
