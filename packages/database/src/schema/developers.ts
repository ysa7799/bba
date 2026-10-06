import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
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

/**
 * A key for the public API. Only the SHA-256 of the key is stored (it is shown once); the
 * prefix identifies it in lists. Scopes are permission keys, a subset of what its creator held.
 * Keys are revoked, never deleted.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    /** First characters of the key, safe to display (e.g. `bos_AbCd1234`). */
    prefix: text().notNull(),
    keyHash: text().notNull(),
    scopes: text().array().notNull(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    revokedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_keys_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('api_keys_hash_unique').on(t.keyHash),
    index('api_keys_org_idx').on(t.organizationId, t.createdAt.desc()),
    check('api_keys_name_check', sql`char_length(${t.name}) between 1 and 100`),
    check('api_keys_scopes_check', sql`cardinality(${t.scopes}) between 1 and 60`),
    tenantIsolationPolicy(),
  ],
);

/** Idempotency of public API writes: the first result for a key is replayed for 24 hours. */
export const apiIdempotencyKeys = pgTable(
  'api_idempotency_keys',
  {
    id: primaryId(),
    organizationId: orgId(),
    apiKeyId: uuid().notNull(),
    key: text().notNull(),
    /** SHA-256 of method, path and body: a reused key with another request is refused. */
    requestHash: text().notNull(),
    status: text({ enum: ['processing', 'completed'] })
      .notNull()
      .default('processing'),
    responseStatus: integer(),
    responseBody: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_idempotency_keys_unique').on(t.apiKeyId, t.key),
    index('api_idempotency_keys_created_idx').on(t.createdAt),
    foreignKey({
      name: 'api_idempotency_keys_api_key_fk',
      columns: [t.apiKeyId, t.organizationId],
      foreignColumns: [apiKeys.id, apiKeys.organizationId],
    }).onDelete('cascade'),
    check('api_idempotency_keys_key_check', sql`char_length(${t.key}) between 1 and 255`),
    check('api_idempotency_keys_status_check', sql`${t.status} in ('processing', 'completed')`),
    tenantIsolationPolicy(),
  ],
);

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * A customer URL that receives signed event notifications. The signing secret is encrypted at
 * rest (it must be usable to sign); after a rotation the previous secret also signs until it
 * expires, so receivers can switch without missing deliveries.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: primaryId(),
    organizationId: orgId(),
    url: text().notNull(),
    description: text(),
    events: text().array().notNull(),
    secretSealed: text().notNull(),
    previousSecretSealed: text(),
    previousSecretExpiresAt: timestamp({ withTimezone: true }),
    status: text({ enum: WEBHOOK_ENDPOINT_STATUSES }).notNull().default('active'),
    /** `manual` (turned off by a person) or `failing` (turned off after repeated failures). */
    disabledReason: text(),
    consecutiveFailures: integer().notNull().default(0),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('webhook_endpoints_id_org_unique').on(t.id, t.organizationId),
    index('webhook_endpoints_org_idx').on(t.organizationId, t.createdAt.desc()),
    check('webhook_endpoints_url_check', sql`char_length(${t.url}) between 8 and 2000`),
    check(
      'webhook_endpoints_description_check',
      sql`${t.description} is null or char_length(${t.description}) <= 500`,
    ),
    check('webhook_endpoints_events_check', sql`cardinality(${t.events}) between 1 and 100`),
    check('webhook_endpoints_status_check', sql`${t.status} in ('active', 'disabled')`),
    check(
      'webhook_endpoints_disabled_check',
      sql`(${t.status} = 'disabled') = (${t.disabledReason} is not null) and (${t.disabledReason} is null or ${t.disabledReason} in ('manual', 'failing'))`,
    ),
    check('webhook_endpoints_failures_check', sql`${t.consecutiveFailures} >= 0`),
    tenantIsolationPolicy(),
  ],
);

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * One event sent to one endpoint. The body is stored as the exact text that is signed and
 * sent, so every attempt (and a manual redelivery) carries identical bytes.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: primaryId(),
    organizationId: orgId(),
    endpointId: uuid().notNull(),
    eventId: uuid().notNull(),
    eventType: text().notNull(),
    body: text().notNull(),
    status: text({ enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }),
    lastAttemptAt: timestamp({ withTimezone: true }),
    responseStatus: integer(),
    lastError: text(),
    durationMs: integer(),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_event_unique').on(t.endpointId, t.eventId),
    index('webhook_deliveries_endpoint_idx').on(
      t.organizationId,
      t.endpointId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_created_idx').on(t.createdAt),
    foreignKey({
      name: 'webhook_deliveries_endpoint_fk',
      columns: [t.endpointId, t.organizationId],
      foreignColumns: [webhookEndpoints.id, webhookEndpoints.organizationId],
    }).onDelete('cascade'),
    check(
      'webhook_deliveries_status_check',
      sql`${t.status} in ('pending', 'succeeded', 'failed')`,
    ),
    check('webhook_deliveries_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'webhook_deliveries_error_check',
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`,
    ),
    check('webhook_deliveries_body_check', sql`char_length(${t.body}) <= 65536`),
    tenantIsolationPolicy(),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
