import {
  channelConnections,
  conversationParticipants,
  conversations,
  conversationTags,
  crmContacts,
  crmTags,
  messageAttachments,
  messages,
  users,
  type Channel,
  type Conversation,
  type Message,
  type TenantTx,
} from '@businessos/database';
import {
  assertActiveMember,
  assertTagsExist,
  displayName,
  escapeLike,
  type CrmContext,
} from '@businessos/crm';
import { emitEvent } from '@businessos/events';
import {
  decodeCursor,
  encodeCursor,
  NotFoundError,
  paginationQuerySchema,
  ValidationError,
  type Page,
} from '@businessos/shared';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

/** WhatsApp only allows free-form replies within 24 hours of the customer's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 3_600_000;

export function canReplyFreely(
  conversation: Pick<Conversation, 'channel' | 'lastInboundAt'>,
  now = Date.now(),
): boolean {
  if (conversation.channel !== 'whatsapp') return true;
  return (
    conversation.lastInboundAt !== null &&
    now - conversation.lastInboundAt.getTime() < WHATSAPP_WINDOW_MS
  );
}

export interface ConversationSummary {
  id: string;
  channel: Channel;
  connection: { id: string; name: string; address: string; provider: string };
  contact: { id: string; name: string } | null;
  counterpart: { address: string; name: string | null };
  subject: string | null;
  status: Conversation['status'];
  assignee: { userId: string; name: string | null } | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  lastInboundAt: string | null;
  canReplyFreely: boolean;
  tags: { id: string; name: string; color: string }[];
  createdAt: string;
}

export const conversationListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  assignee: z
    .union([z.uuid(), z.literal('me'), z.literal('none'), z.literal('all')])
    .default('all'),
  channel: z.enum(['email', 'whatsapp', 'sms']).optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
  contactId: z.uuid().optional(),
  tagId: z.uuid().optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

const cursorSchema = z.object({ t: z.string().max(64), id: z.uuid() });
const sortExpression = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;

function columns() {
  return {
    conversation: conversations,
    connectionName: channelConnections.name,
    connectionAddress: channelConnections.address,
    connectionProvider: channelConnections.provider,
    assigneeName: users.name,
    contactFirstName: crmContacts.firstName,
    contactLastName: crmContacts.lastName,
    contactEmail: crmContacts.email,
    contactPhone: crmContacts.phone,
    contactLive: sql<boolean>`${crmContacts.id} is not null and ${crmContacts.deletedAt} is null`,
    sortValue: sql<string>`(${sortExpression})::text`,
  };
}

function baseQuery(tx: TenantTx) {
  return tx
    .select(columns())
    .from(conversations)
    .innerJoin(channelConnections, eq(channelConnections.id, conversations.connectionId))
    .leftJoin(users, eq(users.id, conversations.assigneeUserId))
    .leftJoin(crmContacts, eq(crmContacts.id, conversations.contactId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

async function tagsFor(tx: TenantTx, ids: readonly string[]) {
  const map = new Map<string, { id: string; name: string; color: string }[]>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({
      conversationId: conversationTags.conversationId,
      id: crmTags.id,
      name: crmTags.name,
      color: crmTags.color,
    })
    .from(conversationTags)
    .innerJoin(crmTags, eq(crmTags.id, conversationTags.tagId))
    .where(inArray(conversationTags.conversationId, [...ids]))
    .orderBy(asc(crmTags.name));
  for (const row of rows) {
    const list = map.get(row.conversationId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    map.set(row.conversationId, list);
  }
  return map;
}

function toSummary(
  ctx: CrmContext,
  row: Row,
  tags: Map<string, { id: string; name: string; color: string }[]>,
): ConversationSummary {
  const c = row.conversation;
  const showContact = (ctx.canRead?.contact ?? true) && c.contactId !== null && row.contactLive;
  return {
    id: c.id,
    channel: c.channel,
    connection: {
      id: c.connectionId,
      name: row.connectionName,
      address: row.connectionAddress,
      provider: row.connectionProvider,
    },
    contact:
      showContact && c.contactId
        ? {
            id: c.contactId,
            name: displayName({
              firstName: row.contactFirstName,
              lastName: row.contactLastName,
              email: row.contactEmail,
              phone: row.contactPhone,
            }),
          }
        : null,
    counterpart: { address: c.counterpartAddress, name: c.counterpartName },
    subject: c.subject,
    status: c.status,
    assignee: c.assigneeUserId ? { userId: c.assigneeUserId, name: row.assigneeName } : null,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageDirection: c.lastMessageDirection,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    canReplyFreely: canReplyFreely(c),
    tags: tags.get(c.id) ?? [],
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listConversations(
  tx: TenantTx,
  ctx: CrmContext,
  query: ConversationListQuery,
): Promise<Page<ConversationSummary>> {
  const conditions: SQL[] = [eq(conversations.organizationId, ctx.organizationId)];
  if (query.status !== 'all') conditions.push(eq(conversations.status, query.status));
  if (query.assignee === 'me') {
    conditions.push(
      ctx.actor.userId ? eq(conversations.assigneeUserId, ctx.actor.userId) : sql`false`,
    );
  } else if (query.assignee === 'none') conditions.push(isNull(conversations.assigneeUserId));
  else if (query.assignee !== 'all')
    conditions.push(eq(conversations.assigneeUserId, query.assignee));
  if (query.channel) conditions.push(eq(conversations.channel, query.channel));
  if (query.unread === 'true') conditions.push(sql`${conversations.unreadCount} > 0`);
  if (query.contactId) conditions.push(eq(conversations.contactId, query.contactId));
  if (query.tagId) {
    conditions.push(
      sql`exists (select 1 from ${conversationTags} where ${conversationTags.conversationId} = ${conversations.id} and ${conversationTags.tagId} = ${query.tagId})`,
    );
  }
  if (query.q) {
    const pattern = `%${escapeLike(query.q.toLowerCase())}%`;
    const search = or(
      sql`lower(${conversations.counterpartAddress}) LIKE ${pattern}`,
      sql`lower(coalesce(${conversations.counterpartName}, '')) LIKE ${pattern}`,
      sql`lower(coalesce(${conversations.subject}, '')) LIKE ${pattern}`,
      sql`lower(coalesce(${conversations.lastMessagePreview}, '')) LIKE ${pattern}`,
    );
    if (search) conditions.push(search);
  }
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    conditions.push(
      sql`(${sortExpression}, ${conversations.id}) < (${position.t}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await baseQuery(tx)
    .where(and(...conditions))
    .orderBy(desc(sortExpression), desc(conversations.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const tags = await tagsFor(
    tx,
    page.map((row) => row.conversation.id),
  );
  const last = page.at(-1);
  return {
    data: page.map((row) => toSummary(ctx, row, tags)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ t: last.sortValue, id: last.conversation.id })
        : null,
  };
}

export async function getConversation(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<ConversationSummary> {
  const [row] = await baseQuery(tx).where(
    and(eq(conversations.id, id), eq(conversations.organizationId, ctx.organizationId)),
  );
  if (!row) throw new NotFoundError('Conversation');
  return toSummary(ctx, row, await tagsFor(tx, [id]));
}

export async function lockConversation(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<Conversation> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.organizationId, organizationId)))
    .for('update');
  if (!row) throw new NotFoundError('Conversation');
  return row;
}

/** Total unread conversations (navigation badge). */
export async function unreadConversationCount(
  tx: TenantTx,
  organizationId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.status, 'open'),
        sql`${conversations.unreadCount} > 0`,
      ),
    );
  return row?.n ?? 0;
}

export interface MessageSummary {
  id: string;
  direction: Message['direction'];
  status: Message['status'];
  author: { userId: string; name: string | null } | null;
  subject: string | null;
  text: string;
  template: Message['template'];
  errorCode: string | null;
  errorMessage: string | null;
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number | null;
    status: string;
  }[];
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export const messageListQuerySchema = paginationQuerySchema;

/** Messages of a conversation, newest first (the UI shows them oldest-first per page). */
export async function listMessages(
  tx: TenantTx,
  ctx: CrmContext,
  conversationId: string,
  query: z.infer<typeof messageListQuerySchema>,
): Promise<Page<MessageSummary>> {
  await getConversation(tx, ctx, conversationId);
  const conditions: SQL[] = [
    eq(messages.conversationId, conversationId),
    eq(messages.organizationId, ctx.organizationId),
  ];
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    conditions.push(
      sql`(${messages.createdAt}, ${messages.id}) < (${position.t}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({
      message: messages,
      authorName: users.name,
      sortValue: sql<string>`${messages.createdAt}::text`,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const ids = page.map((row) => row.message.id);
  const attachments =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, ids));
  const last = page.at(-1);
  return {
    data: page.map(({ message: m, authorName }) => ({
      id: m.id,
      direction: m.direction,
      status: m.status,
      author: m.authorUserId ? { userId: m.authorUserId, name: authorName } : null,
      subject: m.subject,
      text: m.bodyText,
      template: m.template,
      errorCode: m.errorCode,
      errorMessage: m.errorMessage,
      attachments: attachments
        .filter((attachment) => attachment.messageId === m.id)
        .map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
          status: attachment.status,
        })),
      createdAt: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
      deliveredAt: m.deliveredAt?.toISOString() ?? null,
      readAt: m.readAt?.toISOString() ?? null,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ t: last.sortValue, id: last.message.id })
        : null,
  };
}

export async function markConversationRead(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<void> {
  await lockConversation(tx, ctx.organizationId, id);
  await tx.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, id));
}

export async function assignConversation(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  assigneeUserId: string | null,
): Promise<ConversationSummary> {
  const current = await lockConversation(tx, ctx.organizationId, id);
  if (assigneeUserId !== null)
    await assertActiveMember(tx, ctx.organizationId, assigneeUserId, 'assigneeUserId');
  if (current.assigneeUserId !== assigneeUserId) {
    await tx.update(conversations).set({ assigneeUserId }).where(eq(conversations.id, id));
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      actor: { type: ctx.actor.type, id: ctx.actor.userId },
      correlationId: ctx.actor.correlationId ?? null,
      type: 'conversation.assigned',
      subject: { type: 'conversation', id },
      payload: { conversationId: id, assigneeUserId },
    });
  }
  return getConversation(tx, ctx, id);
}

export async function setConversationStatus(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  status: Conversation['status'],
): Promise<ConversationSummary> {
  const current = await lockConversation(tx, ctx.organizationId, id);
  if (current.status !== status) {
    await tx
      .update(conversations)
      .set({
        status,
        closedAt: status === 'closed' ? new Date() : null,
        ...(status === 'closed' ? { unreadCount: 0 } : {}),
      })
      .where(eq(conversations.id, id));
    await emitEvent(tx, {
      organizationId: ctx.organizationId,
      actor: { type: ctx.actor.type, id: ctx.actor.userId },
      correlationId: ctx.actor.correlationId ?? null,
      type: 'conversation.status_changed',
      subject: { type: 'conversation', id },
      payload: { conversationId: id, status },
    });
  }
  return getConversation(tx, ctx, id);
}

export async function setConversationTags(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  tagIds: readonly string[],
): Promise<ConversationSummary> {
  await lockConversation(tx, ctx.organizationId, id);
  const unique = [...new Set(tagIds)];
  if (unique.length > 50)
    throw new ValidationError('Too many tags', [{ path: 'tagIds', message: 'At most 50' }]);
  await assertTagsExist(tx, ctx.organizationId, unique);
  await tx.delete(conversationTags).where(eq(conversationTags.conversationId, id));
  if (unique.length > 0) {
    await tx
      .insert(conversationTags)
      .values(
        unique.map((tagId) => ({ organizationId: ctx.organizationId, conversationId: id, tagId })),
      );
  }
  return getConversation(tx, ctx, id);
}

/** Address of a contact for a channel (email for email, WhatsApp/phone number otherwise). */
export function contactAddress(
  contact: { email: string | null; phone: string | null; whatsappPhone: string | null },
  channel: Channel,
): string | null {
  switch (channel) {
    case 'email':
      return contact.email;
    case 'whatsapp':
      return contact.whatsappPhone ?? contact.phone;
    case 'sms':
      return contact.phone ?? contact.whatsappPhone;
  }
}

export const startConversationInputSchema = z.object({
  connectionId: z.uuid(),
  contactId: z.uuid(),
  subject: z.string().trim().max(300).optional(),
});

/** Opens (or reuses) the conversation with a contact on a channel, for outbound-first messages. */
export async function startConversation(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof startConversationInputSchema>,
): Promise<{ conversation: ConversationSummary; created: boolean }> {
  const input = startConversationInputSchema.parse(rawInput);
  const [connection] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, input.connectionId),
        eq(channelConnections.organizationId, ctx.organizationId),
      ),
    );
  if (!connection || connection.status === 'disconnected') {
    throw new ValidationError('Unknown channel', [
      { path: 'connectionId', message: 'Channel not found' },
    ]);
  }
  const [contact] = await tx
    .select()
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.id, input.contactId),
        eq(crmContacts.organizationId, ctx.organizationId),
        isNull(crmContacts.deletedAt),
      ),
    );
  if (!contact)
    throw new ValidationError('Unknown contact', [
      { path: 'contactId', message: 'Contact not found' },
    ]);
  const address = contactAddress(contact, connection.channel);
  if (!address) {
    throw new ValidationError('The contact has no address for this channel', [
      {
        path: 'contactId',
        message:
          connection.channel === 'email'
            ? 'Add an email address first'
            : 'Add a phone number first',
      },
    ]);
  }
  const [existing] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.connectionId, connection.id),
        eq(conversations.counterpartAddress, address),
      ),
    );
  if (existing) {
    await tx
      .update(conversations)
      .set({
        contactId: contact.id,
        status: 'open',
        closedAt: null,
        ...(input.subject ? { subject: input.subject } : {}),
      })
      .where(eq(conversations.id, existing.id));
    return { conversation: await getConversation(tx, ctx, existing.id), created: false };
  }
  const [created] = await tx
    .insert(conversations)
    .values({
      organizationId: ctx.organizationId,
      channel: connection.channel,
      connectionId: connection.id,
      contactId: contact.id,
      counterpartAddress: address,
      counterpartName: displayName(contact),
      subject: input.subject ?? null,
      assigneeUserId: ctx.actor.userId,
    })
    .returning();
  if (!created) throw new Error('conversation insert returned no row');
  await tx.insert(conversationParticipants).values({
    organizationId: ctx.organizationId,
    conversationId: created.id,
    kind: 'contact',
    role: 'counterpart',
    contactId: contact.id,
    address,
    displayName: displayName(contact),
  });
  await emitEvent(tx, {
    organizationId: ctx.organizationId,
    actor: { type: ctx.actor.type, id: ctx.actor.userId },
    correlationId: ctx.actor.correlationId ?? null,
    type: 'conversation.created',
    subject: { type: 'conversation', id: created.id },
    payload: { conversationId: created.id, channel: created.channel, contactId: contact.id },
  });
  return { conversation: await getConversation(tx, ctx, created.id), created: true };
}
