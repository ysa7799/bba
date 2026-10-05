import type { QuotaKey } from '@businessos/billing';
import { consumeUsage } from '@businessos/billing';
import {
  channelConnections,
  channelTemplates,
  communicationWebhookEvents,
  conversationParticipants,
  conversations,
  crmContacts,
  messageAttachments,
  messages,
  organizations,
  withSystem,
  withTenant,
  type Channel,
  type ChannelConnection,
  type Conversation,
  type Database,
  type Message,
  type TenantTx,
} from '@businessos/database';
import { createContact, normalizeEmail, normalizePhone, type CrmContext } from '@businessos/crm';
import { emitEvent } from '@businessos/events';
import {
  ConflictError,
  EntitlementExceededError,
  isAppError,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  findConnectionByWebhookToken,
  resolveConnection,
  type CommunicationsServices,
} from './connections';
import { canReplyFreely, lockConversation } from './conversations';
import { MessagingProviderError } from './providers/util';
import {
  WebhookSignatureError,
  type InboundMessageEvent,
  type NormalizedEvent,
  type StatusEvent,
  type WebhookRequest,
} from './types';

export const QUOTA_KEYS: Record<Channel, QuotaKey> = {
  email: 'email.monthly_limit',
  whatsapp: 'whatsapp.monthly_limit',
  sms: 'sms.monthly_limit',
};

const PREVIEW_LENGTH = 160;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}

export const sendMessageInputSchema = z
  .object({
    text: z.string().max(10_000).default(''),
    subject: z.string().trim().max(300).optional(),
    template: z
      .object({
        name: z.string().regex(/^[a-z0-9_]{1,512}$/),
        language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
        parameters: z.array(z.string().max(1_000)).max(20).default([]),
      })
      .optional(),
  })
  .refine((input) => input.template !== undefined || input.text.trim().length > 0, {
    message: 'Write a message',
    path: ['text'],
  });
export const noteInputSchema = z.object({ text: z.string().trim().min(1).max(10_000) });

/**
 * Queues an outbound message: checks the channel is usable, enforces WhatsApp's 24-hour window
 * (templates outside it), consumes the monthly channel quota (once per message) and stores the
 * message as `queued`. The caller enqueues `communications.send` after commit.
 */
export async function queueMessage(
  tx: TenantTx,
  ctx: CrmContext,
  conversationId: string,
  rawInput: z.input<typeof sendMessageInputSchema>,
): Promise<Message> {
  const input = sendMessageInputSchema.parse(rawInput);
  const conversation = await lockConversation(tx, ctx.organizationId, conversationId);
  const [connection] = await tx
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, conversation.connectionId));
  if (!connection || connection.status === 'disconnected')
    throw new ConflictError('This channel is disconnected');
  if (connection.status !== 'active') {
    throw new ConflictError('This channel is not configured yet (CONFIGURATION_REQUIRED)');
  }
  let template: Message['template'] = null;
  if (input.template) {
    if (conversation.channel !== 'whatsapp') {
      throw new ValidationError('Templates are only available on WhatsApp', [
        { path: 'template', message: 'Not supported' },
      ]);
    }
    const [registered] = await tx
      .select()
      .from(channelTemplates)
      .where(
        and(
          eq(channelTemplates.connectionId, connection.id),
          eq(channelTemplates.name, input.template.name),
          eq(channelTemplates.language, input.template.language),
          eq(channelTemplates.status, 'approved'),
        ),
      );
    if (!registered)
      throw new ValidationError('Unknown template', [
        { path: 'template.name', message: 'No approved template' },
      ]);
    if (registered.variableCount !== input.template.parameters.length) {
      throw new ValidationError('Wrong number of template parameters', [
        { path: 'template.parameters', message: `Expected ${registered.variableCount}` },
      ]);
    }
    template = input.template;
  } else if (!canReplyFreely(conversation)) {
    throw new ConflictError(
      'More than 24 hours have passed since the customer last wrote; WhatsApp only allows an approved template now',
      { details: [{ path: 'template', message: 'Use an approved template' }] },
    );
  }
  const [message] = await tx
    .insert(messages)
    .values({
      organizationId: ctx.organizationId,
      conversationId,
      connectionId: connection.id,
      direction: 'outbound',
      status: 'queued',
      authorUserId: ctx.actor.userId,
      subject:
        conversation.channel === 'email' ? (input.subject ?? conversation.subject ?? null) : null,
      bodyText: template ? renderTemplatePreview(template) : input.text,
      template,
    })
    .returning();
  if (!message) throw new Error('message insert returned no row');
  await consumeUsage(tx, ctx.organizationId, QUOTA_KEYS[conversation.channel], 1, {
    idempotencyKey: `message:${message.id}`,
    source: 'communications.send',
  });
  await tx
    .update(conversations)
    .set({
      status: 'open',
      closedAt: null,
      unreadCount: 0,
      lastMessageAt: message.createdAt,
      lastMessagePreview: preview(message.bodyText),
      lastMessageDirection: 'outbound',
      ...(conversation.channel === 'email' && input.subject && !conversation.subject
        ? { subject: input.subject }
        : {}),
    })
    .where(eq(conversations.id, conversationId));
  return message;
}

function renderTemplatePreview(template: NonNullable<Message['template']>): string {
  return `[Template ${template.name}]${template.parameters.length > 0 ? ` ${template.parameters.join(' · ')}` : ''}`;
}

/** Internal note in a conversation: visible to the team only, never sent. */
export async function addInternalNote(
  tx: TenantTx,
  ctx: CrmContext,
  conversationId: string,
  rawInput: z.input<typeof noteInputSchema>,
): Promise<Message> {
  const { text } = noteInputSchema.parse(rawInput);
  const conversation = await lockConversation(tx, ctx.organizationId, conversationId);
  const [message] = await tx
    .insert(messages)
    .values({
      organizationId: ctx.organizationId,
      conversationId,
      connectionId: conversation.connectionId,
      direction: 'internal',
      status: 'sent',
      authorUserId: ctx.actor.userId,
      bodyText: text,
    })
    .returning();
  if (!message) throw new Error('note insert returned no row');
  return message;
}

export type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'retry';

/**
 * Worker: sends one queued message through its provider. Claims the message (`sending`) in a
 * short transaction, calls the provider outside any transaction, then records the outcome.
 * Retryable provider errors put the message back to `queued` and rethrow so the job retries
 * with backoff; on the final attempt (or a permanent error) the message is marked `failed`.
 */
export async function deliverMessage(
  db: Database,
  services: CommunicationsServices,
  organizationId: string,
  messageId: string,
  options: { finalAttempt: boolean },
): Promise<DeliveryOutcome> {
  const claimed = await withTenant(db, { organizationId, userId: null }, async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.organizationId, organizationId)))
      .for('update');
    if (
      message?.direction !== 'outbound' ||
      (message.status !== 'queued' && message.status !== 'sending')
    )
      return null;
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, message.conversationId));
    const [connection] = await tx
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, message.connectionId));
    if (!conversation || !connection) return null;
    await tx
      .update(messages)
      .set({ status: 'sending', attempts: sql`${messages.attempts} + 1` })
      .where(eq(messages.id, messageId));
    const [replyTo] = await tx
      .select({ providerMessageId: messages.providerMessageId })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'inbound')))
      .orderBy(sql`${messages.createdAt} desc`)
      .limit(1);
    return { message, conversation, connection, replyTo: replyTo?.providerMessageId ?? null };
  });
  if (!claimed) return 'skipped';
  const { message, conversation, connection } = claimed;

  const fail = async (code: string | null, reason: string) =>
    withTenant(db, { organizationId, userId: null }, async (tx) => {
      await tx
        .update(messages)
        .set({
          status: 'failed',
          failedAt: new Date(),
          errorCode: code,
          errorMessage: reason.slice(0, 500),
        })
        .where(eq(messages.id, messageId));
      await emitEvent(tx, {
        organizationId,
        actor: { type: 'system', id: null },
        correlationId: `message:${messageId}`,
        type: 'message.failed',
        subject: { type: 'message', id: messageId },
        payload: { messageId, conversationId: conversation.id, errorCode: code },
      });
    });

  const provider = services.providers.get(connection.provider);
  if (!provider) {
    await fail('provider_unavailable', 'The channel provider is not available on this deployment');
    return 'failed';
  }
  if (connection.status !== 'active') {
    await fail('configuration_required', 'The channel is not configured');
    return 'failed';
  }
  try {
    const resolved = resolveConnection(services, connection);
    const result = await provider.send(resolved, {
      id: message.id,
      to: conversation.counterpartAddress,
      from: connection.address,
      subject: message.subject,
      text: message.bodyText,
      template: message.template,
      replyToProviderMessageId: claimed.replyTo,
    });
    await withTenant(db, { organizationId, userId: null }, async (tx) => {
      await tx
        .update(messages)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        })
        .where(eq(messages.id, messageId));
      await emitEvent(tx, {
        organizationId,
        actor: message.authorUserId
          ? { type: 'user', id: message.authorUserId }
          : { type: 'system', id: null },
        correlationId: `message:${messageId}`,
        type: 'message.sent',
        subject: { type: 'message', id: messageId },
        payload: {
          messageId,
          conversationId: conversation.id,
          channel: conversation.channel,
          contactId: conversation.contactId,
        },
      });
    });
    return 'sent';
  } catch (error) {
    const retryable =
      error instanceof MessagingProviderError ? error.retryable : !isAppError(error);
    const code = error instanceof MessagingProviderError ? error.providerCode : null;
    const reason = error instanceof Error ? error.message : 'Sending failed';
    if (retryable && !options.finalAttempt) {
      await withTenant(db, { organizationId, userId: null }, (tx) =>
        tx
          .update(messages)
          .set({ status: 'queued', errorCode: code, errorMessage: reason.slice(0, 500) })
          .where(eq(messages.id, messageId)),
      );
      throw error;
    }
    await fail(code, reason);
    return 'failed';
  }
}

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** Applies a provider delivery status: forward-only; failures are terminal. */
async function applyStatus(
  tx: TenantTx,
  connection: ChannelConnection,
  event: StatusEvent,
): Promise<boolean> {
  const [message] = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.connectionId, connection.id),
        eq(messages.providerMessageId, event.providerMessageId),
      ),
    )
    .for('update');
  if (message?.direction !== 'outbound' || message.status === 'failed') return false;
  if (event.status === 'failed') {
    await tx
      .update(messages)
      .set({
        status: 'failed',
        failedAt: event.timestamp,
        errorCode: event.error?.code ?? null,
        errorMessage: event.error?.message ?? null,
      })
      .where(eq(messages.id, message.id));
    await emitEvent(tx, {
      organizationId: connection.organizationId,
      actor: { type: 'system', id: null },
      correlationId: `message:${message.id}`,
      type: 'message.failed',
      subject: { type: 'message', id: message.id },
      payload: {
        messageId: message.id,
        conversationId: message.conversationId,
        errorCode: event.error?.code ?? null,
      },
    });
    return true;
  }
  if ((STATUS_RANK[event.status] ?? -1) <= (STATUS_RANK[message.status] ?? -1)) return false;
  await tx
    .update(messages)
    .set({
      status: event.status,
      ...(event.status === 'delivered' ? { deliveredAt: event.timestamp } : {}),
      ...(event.status === 'read'
        ? { readAt: event.timestamp, deliveredAt: message.deliveredAt ?? event.timestamp }
        : {}),
    })
    .where(eq(messages.id, message.id));
  return true;
}

/** Sender address normalized per channel (unparseable SMS senders such as "BANK" stay as-is). */
export function normalizeCounterpart(
  channel: Channel,
  raw: string,
  countryCode: string,
): string | null {
  try {
    if (channel === 'email') return normalizeEmail(raw);
    return normalizePhone(raw, countryCode);
  } catch {
    if (channel === 'email') return null;
    // The provider has authenticated the sender and number metadata can lag newly allocated
    // ranges: keep any well-formed E.164 address instead of dropping the customer's message.
    const e164 = raw
      .trim()
      .replace(/^00/, '+')
      .replace(/[\s().-]/g, '');
    if (/^\+[1-9]\d{6,14}$/.test(e164)) return e164;
    if (channel === 'sms' && /^[A-Za-z0-9 ]{2,15}$/.test(raw.trim()))
      return raw.trim().toUpperCase();
    return null;
  }
}

async function identifyContact(
  tx: TenantTx,
  ctx: CrmContext,
  channel: Channel,
  address: string,
  name: string | null,
): Promise<string | null> {
  const match =
    channel === 'email'
      ? eq(crmContacts.email, address)
      : or(eq(crmContacts.phone, address), eq(crmContacts.whatsappPhone, address));
  const [existing] = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(eq(crmContacts.organizationId, ctx.organizationId), isNull(crmContacts.deletedAt), match),
    )
    .orderBy(asc(crmContacts.createdAt))
    .limit(1);
  if (existing) return existing.id;
  if (!address.startsWith('+') && channel !== 'email') return null;
  try {
    const [first, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean);
    const created = await tx.transaction((sp) =>
      createContact(sp as TenantTx, ctx, {
        firstName: first ?? null,
        lastName: rest.length > 0 ? rest.join(' ') : null,
        ...(channel === 'email'
          ? { email: address }
          : channel === 'whatsapp'
            ? { whatsappPhone: address, phone: address }
            : { phone: address }),
        source: channel,
        ownerUserId: null,
      }),
    );
    return created.id;
  } catch (error) {
    // Over the contact limit, a concurrent duplicate or an address the CRM does not accept
    // (e.g. a number outside known ranges): keep the conversation without a contact.
    if (
      error instanceof EntitlementExceededError ||
      error instanceof ConflictError ||
      error instanceof ValidationError
    )
      return null;
    throw error;
  }
}

/**
 * Inbound pipeline for one message: dedupe → identify contact → resolve conversation → save
 * message (+ attachment metadata) → update conversation → domain events. Runs inside the
 * connection's tenant; returns false for duplicates.
 */
async function ingestMessage(
  tx: TenantTx,
  ctx: CrmContext,
  connection: ChannelConnection,
  event: InboundMessageEvent,
): Promise<boolean> {
  const [duplicate] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.connectionId, connection.id),
        eq(messages.providerMessageId, event.providerMessageId),
      ),
    );
  if (duplicate) return false;
  const address = normalizeCounterpart(connection.channel, event.from, ctx.countryCode);
  if (!address) return false;
  const [existing] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.connectionId, connection.id),
        eq(conversations.counterpartAddress, address),
      ),
    )
    .for('update');
  let conversation: Conversation | undefined = existing;
  let created = false;
  const contactId =
    existing?.contactId ??
    (await identifyContact(tx, ctx, connection.channel, address, event.fromName));
  if (!conversation) {
    // A concurrent webhook may create the same thread first: fall back to its row.
    [conversation] = await tx
      .insert(conversations)
      .values({
        organizationId: ctx.organizationId,
        channel: connection.channel,
        connectionId: connection.id,
        contactId,
        counterpartAddress: address,
        counterpartName: event.fromName,
        subject: event.subject,
      })
      .onConflictDoNothing({
        target: [conversations.connectionId, conversations.counterpartAddress],
      })
      .returning();
    created = conversation !== undefined;
    conversation ??= (
      await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.connectionId, connection.id),
            eq(conversations.counterpartAddress, address),
          ),
        )
        .for('update')
    )[0];
    if (!conversation) throw new Error('conversation could not be resolved');
  }
  if (created) {
    await tx.insert(conversationParticipants).values({
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      kind: contactId ? 'contact' : 'external',
      role: 'counterpart',
      contactId,
      address,
      displayName: event.fromName,
    });
  }
  const inserted = await tx
    .insert(messages)
    .values({
      organizationId: ctx.organizationId,
      conversationId: conversation.id,
      connectionId: connection.id,
      direction: 'inbound',
      status: 'received',
      subject: event.subject,
      bodyText: event.text,
      providerMessageId: event.providerMessageId,
      providerTimestamp: event.timestamp,
    })
    .onConflictDoNothing()
    .returning();
  const message = inserted[0];
  if (!message) return false;
  if (event.attachments.length > 0) {
    await tx.insert(messageAttachments).values(
      event.attachments.map((attachment) => ({
        organizationId: ctx.organizationId,
        messageId: message.id,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        providerMediaId: attachment.providerMediaId,
        status: 'pending' as const,
      })),
    );
  }
  const now = new Date();
  await tx
    .update(conversations)
    .set({
      status: 'open',
      closedAt: null,
      contactId: conversation.contactId ?? contactId,
      counterpartName: conversation.counterpartName ?? event.fromName,
      subject: conversation.subject ?? event.subject,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      lastMessageAt: now,
      lastMessagePreview: preview(event.text || (event.attachments[0]?.fileName ?? '')),
      lastMessageDirection: 'inbound',
      lastInboundAt: now,
    })
    .where(eq(conversations.id, conversation.id));
  await tx
    .update(channelConnections)
    .set({ lastInboundAt: now })
    .where(eq(channelConnections.id, connection.id));
  const base = {
    organizationId: ctx.organizationId,
    actor: { type: 'system' as const, id: null },
    correlationId: `message:${message.id}`,
  };
  if (created) {
    await emitEvent(tx, {
      ...base,
      type: 'conversation.created',
      subject: { type: 'conversation', id: conversation.id },
      payload: { conversationId: conversation.id, channel: connection.channel, contactId },
    });
  }
  await emitEvent(tx, {
    ...base,
    type: 'message.received',
    subject: { type: 'message', id: message.id },
    payload: {
      messageId: message.id,
      conversationId: conversation.id,
      channel: connection.channel,
      contactId: conversation.contactId ?? contactId,
    },
  });
  return true;
}

export type WebhookOutcome =
  | { status: 'not_found' }
  | { status: 'invalid_signature' }
  | { status: 'processed'; received: number; statuses: number; duplicates: number }
  | { status: 'challenge'; challenge: string };

async function logWebhook(
  db: Database,
  provider: string,
  connection: ChannelConnection | null,
  outcome: string,
  signatureValid: boolean,
  eventCount: number,
  error: string | null,
): Promise<void> {
  // System scope: the webhook log is platform-level (tenants cannot read or write it).
  await withSystem(db, (tx) =>
    tx.insert(communicationWebhookEvents).values({
      provider: provider.slice(0, 40),
      connectionId: connection?.id ?? null,
      organizationId: connection?.organizationId ?? null,
      signatureValid,
      outcome,
      eventCount,
      error,
    }),
  );
}

async function contextFor(tx: TenantTx, connection: ChannelConnection): Promise<CrmContext> {
  const [org] = await tx
    .select({
      countryCode: organizations.countryCode,
      defaultCurrency: organizations.defaultCurrency,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, connection.organizationId));
  if (!org) throw new NotFoundError('Organization');
  return {
    organizationId: connection.organizationId,
    ...org,
    actor: { type: 'system', userId: null, correlationId: `webhook:${connection.id}` },
  };
}

/**
 * Inbound webhook entry point: route by URL token → verify authenticity → normalize →
 * process each event in the connection's tenant (each in its own transaction, idempotent).
 * Unknown tokens and bad signatures are logged without touching tenant data.
 */
export async function handleChannelWebhook(
  db: Database,
  services: CommunicationsServices,
  providerKey: string,
  token: string,
  request: WebhookRequest,
): Promise<WebhookOutcome> {
  const provider = services.providers.get(providerKey);
  const connection = provider ? await findConnectionByWebhookToken(db, providerKey, token) : null;
  if (!provider || !connection) {
    await logWebhook(db, providerKey, null, 'unknown_connection', false, 0, null);
    return { status: 'not_found' };
  }
  let events: NormalizedEvent[];
  try {
    events = provider.parseWebhook(resolveConnection(services, connection), request);
  } catch (error) {
    if (error instanceof WebhookSignatureError || isAppError(error)) {
      await logWebhook(
        db,
        providerKey,
        connection,
        'invalid_signature',
        false,
        0,
        error.message.slice(0, 200),
      );
      return { status: 'invalid_signature' };
    }
    throw error;
  }
  let received = 0;
  let statuses = 0;
  let duplicates = 0;
  for (const event of events) {
    const changed = await withTenant(
      db,
      { organizationId: connection.organizationId, userId: null },
      async (tx) => {
        if (event.kind === 'status') return applyStatus(tx, connection, event);
        return ingestMessage(tx, await contextFor(tx, connection), connection, event);
      },
    );
    if (!changed) duplicates += 1;
    else if (event.kind === 'status') statuses += 1;
    else received += 1;
  }
  await logWebhook(db, providerKey, connection, 'processed', true, events.length, null);
  return { status: 'processed', received, statuses, duplicates };
}

/** GET subscription handshake (WhatsApp `hub.challenge`). */
export async function handleWebhookVerification(
  db: Database,
  services: CommunicationsServices,
  providerKey: string,
  token: string,
  query: Record<string, string | undefined>,
): Promise<WebhookOutcome> {
  const provider = services.providers.get(providerKey);
  const connection = provider?.verifySubscription
    ? await findConnectionByWebhookToken(db, providerKey, token)
    : null;
  if (!provider?.verifySubscription || !connection) return { status: 'not_found' };
  const challenge = provider.verifySubscription(resolveConnection(services, connection), query);
  await logWebhook(
    db,
    providerKey,
    connection,
    challenge ? 'verified' : 'verification_failed',
    challenge !== null,
    0,
    null,
  );
  return challenge ? { status: 'challenge', challenge } : { status: 'invalid_signature' };
}

export const templateInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  category: z.enum(['marketing', 'utility', 'authentication']),
  body: z.string().trim().min(1).max(1_024),
});

/** Registers a provider-approved WhatsApp template (variables `{{1}}`… counted from the body). */
export async function registerTemplate(
  tx: TenantTx,
  organizationId: string,
  connectionId: string,
  rawInput: z.input<typeof templateInputSchema>,
) {
  const input = templateInputSchema.parse(rawInput);
  const [connection] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, connectionId),
        eq(channelConnections.organizationId, organizationId),
      ),
    );
  if (!connection) throw new NotFoundError('Channel');
  if (connection.channel !== 'whatsapp') {
    throw new ValidationError('Templates are only for WhatsApp channels', [
      { path: 'connectionId', message: 'Not WhatsApp' },
    ]);
  }
  const variables = new Set(
    [...input.body.matchAll(/\{\{(\d{1,2})\}\}/g)].map((match) => Number(match[1])),
  );
  const count = variables.size;
  if ([...variables].some((n) => n < 1 || n > count)) {
    throw new ValidationError('Template variables must be numbered {{1}}…{{n}}', [
      { path: 'body', message: 'Check variable numbers' },
    ]);
  }
  const [template] = await tx
    .insert(channelTemplates)
    .values({ organizationId, connectionId, ...input, variableCount: count })
    .onConflictDoUpdate({
      target: [channelTemplates.connectionId, channelTemplates.name, channelTemplates.language],
      set: { body: input.body, category: input.category, variableCount: count, status: 'approved' },
    })
    .returning();
  return template;
}

export async function listTemplates(tx: TenantTx, organizationId: string, connectionId?: string) {
  const conditions = [
    eq(channelTemplates.organizationId, organizationId),
    eq(channelTemplates.status, 'approved'),
  ];
  if (connectionId) conditions.push(eq(channelTemplates.connectionId, connectionId));
  return tx
    .select({
      id: channelTemplates.id,
      connectionId: channelTemplates.connectionId,
      name: channelTemplates.name,
      language: channelTemplates.language,
      category: channelTemplates.category,
      body: channelTemplates.body,
      variableCount: channelTemplates.variableCount,
    })
    .from(channelTemplates)
    .where(and(...conditions))
    .orderBy(asc(channelTemplates.name))
    .limit(200);
}
