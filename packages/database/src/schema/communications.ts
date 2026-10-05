import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { crmContacts, crmTags } from './crm';
import { organizations } from './organizations';
import { users } from './users';

export const CHANNELS = ['email', 'whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONNECTION_STATUSES = [
  'active',
  'configuration_required',
  'error',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

/**
 * A tenant's connection to a messaging provider for one channel (an email sending domain/inbox,
 * a WhatsApp Business phone number, an SMS number or sender id). Credentials are sealed with
 * the platform SecretBox (bound to organization + connection id) and never returned by the API.
 * Inbound webhooks are routed by an unguessable per-connection token (stored as a hash).
 */
export const channelConnections = pgTable(
  'channel_connections',
  {
    id: primaryId(),
    organizationId: orgId(),
    channel: text({ enum: CHANNELS }).notNull(),
    provider: text().notNull(),
    name: text().notNull(),
    status: text({ enum: CONNECTION_STATUSES }).notNull().default('configuration_required'),
    /** Sending identity: email address, E.164 number or alphanumeric sender id. */
    address: text().notNull(),
    /** Provider-side account id used for routing (e.g. WhatsApp phone_number_id). */
    externalAccountId: text(),
    webhookTokenHash: text().notNull(),
    credentialsCiphertext: text(),
    /** Non-secret provider settings. */
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    lastError: text(),
    lastInboundAt: timestamp({ withTimezone: true }),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('channel_connections_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('channel_connections_webhook_token_unique').on(t.webhookTokenHash),
    uniqueIndex('channel_connections_provider_account_unique')
      .on(t.provider, t.externalAccountId)
      .where(sql`${t.externalAccountId} is not null and ${t.status} <> 'disconnected'`),
    index('channel_connections_org_idx').on(t.organizationId, t.channel),
    check('channel_connections_channel_check', sql`${t.channel} in ('email', 'whatsapp', 'sms')`),
    check(
      'channel_connections_status_check',
      sql`${t.status} in ('active', 'configuration_required', 'error', 'disconnected')`,
    ),
    check('channel_connections_provider_check', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check('channel_connections_name_check', sql`char_length(${t.name}) between 1 and 100`),
    tenantIsolationPolicy(),
  ],
);

export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * One thread with one counterpart on one connection (reopened when they write again). Unread
 * state is shared by the team (a shared inbox), not per member.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: primaryId(),
    organizationId: orgId(),
    channel: text({ enum: CHANNELS }).notNull(),
    connectionId: uuid().notNull(),
    contactId: uuid(),
    /** Normalized counterpart address (lower-case email or E.164). */
    counterpartAddress: text().notNull(),
    counterpartName: text(),
    subject: text(),
    status: text({ enum: CONVERSATION_STATUSES }).notNull().default('open'),
    assigneeUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    unreadCount: integer().notNull().default(0),
    lastMessageAt: timestamp({ withTimezone: true }),
    lastMessagePreview: text(),
    lastMessageDirection: text(),
    /** Last inbound message (WhatsApp's 24-hour customer service window). */
    lastInboundAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('conversations_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('conversations_connection_counterpart_unique').on(
      t.connectionId,
      t.counterpartAddress,
    ),
    index('conversations_inbox_idx').on(
      t.organizationId,
      t.status,
      t.lastMessageAt.desc(),
      t.id.desc(),
    ),
    index('conversations_assignee_idx').on(t.organizationId, t.assigneeUserId, t.status),
    index('conversations_contact_idx').on(t.contactId),
    foreignKey({
      name: 'conversations_connection_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [channelConnections.id, channelConnections.organizationId],
    }),
    foreignKey({
      name: 'conversations_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    check('conversations_channel_check', sql`${t.channel} in ('email', 'whatsapp', 'sms')`),
    check('conversations_status_check', sql`${t.status} in ('open', 'closed')`),
    check('conversations_unread_check', sql`${t.unreadCount} >= 0`),
    tenantIsolationPolicy(),
  ],
);

export const PARTICIPANT_KINDS = ['contact', 'external', 'user'] as const;

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: primaryId(),
    organizationId: orgId(),
    conversationId: uuid().notNull(),
    kind: text({ enum: PARTICIPANT_KINDS }).notNull(),
    role: text().notNull().default('counterpart'),
    contactId: uuid(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    address: text(),
    displayName: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_participants_conversation_idx').on(t.conversationId),
    uniqueIndex('conversation_participants_address_unique')
      .on(t.conversationId, t.role, t.address)
      .where(sql`${t.address} is not null`),
    foreignKey({
      name: 'conversation_participants_conversation_fk',
      columns: [t.conversationId, t.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_participants_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    check(
      'conversation_participants_kind_check',
      sql`${t.kind} in ('contact', 'external', 'user')`,
    ),
    check(
      'conversation_participants_role_check',
      sql`${t.role} in ('counterpart', 'cc', 'member')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const conversationTags = pgTable(
  'conversation_tags',
  {
    organizationId: orgId(),
    conversationId: uuid().notNull(),
    tagId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.tagId] }),
    index('conversation_tags_tag_idx').on(t.tagId),
    foreignKey({
      name: 'conversation_tags_conversation_fk',
      columns: [t.conversationId, t.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_tags_tag_fk',
      columns: [t.tagId, t.organizationId],
      foreignColumns: [crmTags.id, crmTags.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Messages and internal notes (`direction = internal`, never sent anywhere). Text only. */
export const messages = pgTable(
  'messages',
  {
    id: primaryId(),
    organizationId: orgId(),
    conversationId: uuid().notNull(),
    connectionId: uuid().notNull(),
    direction: text({ enum: MESSAGE_DIRECTIONS }).notNull(),
    status: text({ enum: MESSAGE_STATUSES }).notNull(),
    authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    subject: text(),
    bodyText: text().notNull().default(''),
    /** Provider template send (WhatsApp): { name, language, parameters }. */
    template: jsonb().$type<{ name: string; language: string; parameters: string[] }>(),
    providerMessageId: text(),
    errorCode: text(),
    errorMessage: text(),
    attempts: integer().notNull().default(0),
    providerTimestamp: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    failedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('messages_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('messages_provider_id_unique')
      .on(t.connectionId, t.providerMessageId)
      .where(sql`${t.providerMessageId} is not null`),
    index('messages_conversation_idx').on(t.conversationId, t.createdAt, t.id),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.conversationId, t.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'messages_connection_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [channelConnections.id, channelConnections.organizationId],
    }),
    check('messages_direction_check', sql`${t.direction} in ('inbound', 'outbound', 'internal')`),
    check(
      'messages_status_check',
      sql`${t.status} in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')`,
    ),
    check('messages_body_check', sql`char_length(${t.bodyText}) <= 65536`),
    tenantIsolationPolicy(),
  ],
);

export const ATTACHMENT_STATUSES = ['pending', 'available', 'unavailable'] as const;

/**
 * Attachment metadata. Inbound media are referenced by provider media id; binary storage
 * arrives with the files service (Phase 16), which fills `storage_key`.
 */
export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: primaryId(),
    organizationId: orgId(),
    messageId: uuid().notNull(),
    fileName: text().notNull(),
    contentType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }),
    providerMediaId: text(),
    storageKey: text(),
    status: text({ enum: ATTACHMENT_STATUSES }).notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('message_attachments_message_idx').on(t.messageId),
    foreignKey({
      name: 'message_attachments_message_fk',
      columns: [t.messageId, t.organizationId],
      foreignColumns: [messages.id, messages.organizationId],
    }).onDelete('cascade'),
    check(
      'message_attachments_status_check',
      sql`${t.status} in ('pending', 'available', 'unavailable')`,
    ),
    check('message_attachments_name_check', sql`char_length(${t.fileName}) between 1 and 255`),
    tenantIsolationPolicy(),
  ],
);

export const TEMPLATE_STATUSES = ['approved', 'pending', 'rejected', 'disabled'] as const;
export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;

/** Provider-approved message templates (WhatsApp) registered for a connection. */
export const channelTemplates = pgTable(
  'channel_templates',
  {
    id: primaryId(),
    organizationId: orgId(),
    connectionId: uuid().notNull(),
    name: text().notNull(),
    language: text().notNull(),
    category: text({ enum: TEMPLATE_CATEGORIES }).notNull(),
    body: text().notNull(),
    variableCount: integer().notNull().default(0),
    status: text({ enum: TEMPLATE_STATUSES }).notNull().default('approved'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('channel_templates_unique').on(t.connectionId, t.name, t.language),
    foreignKey({
      name: 'channel_templates_connection_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [channelConnections.id, channelConnections.organizationId],
    }).onDelete('cascade'),
    check(
      'channel_templates_name_check',
      sql`${t.name} ~ '^[a-z0-9_]+$' and char_length(${t.name}) <= 512`,
    ),
    check('channel_templates_language_check', sql`${t.language} ~ '^[a-z]{2,3}(_[A-Z]{2})?$'`),
    check('channel_templates_variables_check', sql`${t.variableCount} between 0 and 20`),
    check(
      'channel_templates_category_check',
      sql`${t.category} in ('marketing', 'utility', 'authentication')`,
    ),
    check(
      'channel_templates_status_check',
      sql`${t.status} in ('approved', 'pending', 'rejected', 'disabled')`,
    ),
    tenantIsolationPolicy(),
  ],
);

/** Inbound webhook log (system only): verification outcome and routing, never message bodies. */
export const communicationWebhookEvents = pgTable(
  'communication_webhook_events',
  {
    id: primaryId(),
    provider: text().notNull(),
    connectionId: uuid(),
    organizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    signatureValid: boolean().notNull(),
    outcome: text().notNull(),
    eventCount: integer().notNull().default(0),
    error: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('communication_webhook_events_received_idx').on(t.receivedAt),
    pgPolicy('system_only', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type ChannelTemplate = typeof channelTemplates.$inferSelect;
