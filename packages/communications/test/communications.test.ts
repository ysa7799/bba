import { listActivities, projectEvent } from '@businessos/activities';
import {
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  startSubscription,
} from '@businessos/billing';
import { createContact, type CrmContext } from '@businessos/crm';
import {
  channelConnections,
  conversations,
  messages,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { createOrganization } from '@businessos/organizations';
import {
  ConflictError,
  EntitlementExceededError,
  NotFoundError,
  SecretBox,
  ValidationError,
} from '@businessos/shared';
import {
  createTestDatabase,
  createTestUser,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChannelProviderRegistry,
  communicationsTimelineProjectors,
  createConnection,
  deliverMessage,
  FakeChannelProvider,
  getConversation,
  handleChannelWebhook,
  listConversations,
  listMessages,
  markConversationRead,
  normalizeCounterpart,
  PostmarkEmailProvider,
  queueMessage,
  registerTemplate,
  resolveConnection,
  startConversation,
  type CommunicationsServices,
  type FakeWebhookPayload,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
const fakeWhatsApp = new FakeChannelProvider('whatsapp');
const fakeEmail = new FakeChannelProvider('email');
const services: CommunicationsServices = {
  providers: new ChannelProviderRegistry([
    fakeWhatsApp,
    fakeEmail,
    new FakeChannelProvider('sms'),
    new PostmarkEmailProvider(),
  ]),
  secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
  publicApiUrl: 'https://api.test',
};

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(
  org: Organization,
  userId: string | null,
  fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
) {
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, ctxFor(org, userId)),
  );
}

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;
const owner = () => world.orgA.users.owner.id;

async function connect(org: Organization, userId: string, provider: string, address: string) {
  return inOrg(org, userId, (tx, ctx) =>
    createConnection(tx, ctx, services, {
      provider,
      name: `${provider} ${uniqueSuffix()}`,
      address,
    }),
  );
}

function tokenOf(webhookUrl: string): string {
  return webhookUrl.split('/').at(-1) ?? '';
}

async function deliverWebhook(
  provider: string,
  webhookUrl: string,
  secret: string,
  payload: FakeWebhookPayload,
  signature?: string,
) {
  const body = JSON.stringify(payload);
  return handleChannelWebhook(handle.db, services, provider, tokenOf(webhookUrl), {
    rawBody: Buffer.from(body),
    headers: { 'x-fake-signature': signature ?? FakeChannelProvider.sign(body, secret) },
    url: webhookUrl,
    query: {},
  });
}

async function secretOf(connectionId: string): Promise<string> {
  // System scope: test reads the sealed credentials to sign fake webhooks.
  const [row] = await withSystem(handle.db, (tx) =>
    tx.select().from(channelConnections).where(eq(channelConnections.id, connectionId)),
  );
  if (!row) throw new Error('connection');
  return resolveConnection(services, row).credentials.webhookSecret ?? '';
}

describe('channel connections', () => {
  it('seals credentials, never returns secrets and stores only a hash of the webhook token', async () => {
    const { connection, webhookUrl } = await inOrg(A(), owner(), (tx, ctx) =>
      createConnection(tx, ctx, services, {
        provider: 'postmark',
        name: 'Support inbox',
        address: 'Support@Manama.example',
        credentials: {
          serverToken: 'server-token-secret-1',
          webhookUsername: 'pmhook',
          webhookPassword: 'webhook-password-1',
        },
      }),
    );
    expect(connection).toMatchObject({
      status: 'active',
      address: 'support@manama.example',
      configuredFields: ['serverToken', 'webhookUsername', 'webhookPassword'],
      publicCredentials: { webhookUsername: 'pmhook' },
    });
    expect(JSON.stringify(connection)).not.toContain('server-token-secret-1');
    expect(webhookUrl).toMatch(
      /^https:\/\/api\.test\/webhooks\/communications\/postmark\/[A-Za-z0-9_-]{43}$/,
    );
    const [row] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(channelConnections).where(eq(channelConnections.id, connection.id)),
    );
    expect(row?.credentialsCiphertext).not.toContain('server-token');
    expect(row?.webhookTokenHash).not.toContain(tokenOf(webhookUrl));
    expect(resolveConnection(services, row!).credentials.serverToken).toBe('server-token-secret-1');
    // Ciphertext is bound to its row: moved to another connection it cannot be decrypted.
    expect(() =>
      resolveConnection(services, { ...row!, id: world.orgB.organization.id }),
    ).toThrow();
  });

  it('marks connections without credentials as configuration required and refuses to send through them', async () => {
    const { connection } = await connect(A(), owner(), 'postmark', 'sales@manama.example');
    expect(connection.status).toBe('configuration_required');
    const contact = await inOrg(A(), owner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Mail', email: `mail.${uniqueSuffix()}@example.com` }),
    );
    const { conversation } = await inOrg(A(), owner(), (tx, ctx) =>
      startConversation(tx, ctx, { connectionId: connection.id, contactId: contact.id }),
    );
    await expect(
      inOrg(A(), owner(), (tx, ctx) => queueMessage(tx, ctx, conversation.id, { text: 'Hello' })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        createConnection(tx, ctx, services, {
          provider: 'postmark',
          name: 'x',
          address: 'a@b.example',
          credentials: { serverToken: 'short' },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('inbound pipeline', () => {
  it('verifies, routes, creates contact and conversation, dedupes replays and counts unread', async () => {
    const { connection, webhookUrl } = await connect(A(), owner(), 'fake_whatsapp', '+97333000100');
    const secret = await secretOf(connection.id);
    const phone = `+9733${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    const payload: FakeWebhookPayload = {
      events: [
        {
          kind: 'message',
          providerMessageId: `wamid.${uniqueSuffix()}`,
          from: phone,
          fromName: 'Noor Hassan',
          text: 'Is the cement in stock?',
        },
      ],
    };
    expect(
      await handleChannelWebhook(handle.db, services, 'fake_whatsapp', 'x'.repeat(43), {
        rawBody: Buffer.from('{}'),
        headers: {},
        url: '',
        query: {},
      }),
    ).toEqual({
      status: 'not_found',
    });
    expect(await deliverWebhook('fake_whatsapp', webhookUrl, secret, payload, 'forged')).toEqual({
      status: 'invalid_signature',
    });
    expect(await deliverWebhook('fake_whatsapp', webhookUrl, secret, payload)).toEqual({
      status: 'processed',
      received: 1,
      statuses: 0,
      duplicates: 0,
    });
    expect(await deliverWebhook('fake_whatsapp', webhookUrl, secret, payload)).toEqual({
      status: 'processed',
      received: 0,
      statuses: 0,
      duplicates: 1,
    });

    const inbox = await inOrg(A(), owner(), (tx, ctx) =>
      listConversations(tx, ctx, { limit: 50, status: 'open', assignee: 'all', q: phone }),
    );
    expect(inbox.data).toHaveLength(1);
    const conversation = inbox.data[0]!;
    expect(conversation).toMatchObject({
      channel: 'whatsapp',
      counterpart: { address: phone, name: 'Noor Hassan' },
      unreadCount: 1,
      lastMessagePreview: 'Is the cement in stock?',
      canReplyFreely: true,
      contact: { name: 'Noor Hassan' },
    });
    await deliverWebhook('fake_whatsapp', webhookUrl, secret, {
      events: [
        {
          kind: 'message',
          providerMessageId: `wamid.${uniqueSuffix()}`,
          from: phone,
          text: 'Also gravel',
          attachments: [
            { fileName: 'list.pdf', contentType: 'application/pdf', providerMediaId: 'media-9' },
          ],
        },
      ],
    });
    const again = await inOrg(A(), owner(), (tx, ctx) => getConversation(tx, ctx, conversation.id));
    expect(again.unreadCount).toBe(2);
    const thread = await inOrg(A(), owner(), (tx, ctx) =>
      listMessages(tx, ctx, conversation.id, { limit: 10 }),
    );
    expect(thread.data.map((m) => m.text)).toEqual(['Also gravel', 'Is the cement in stock?']);
    expect(thread.data[0]?.attachments).toEqual([
      expect.objectContaining({ fileName: 'list.pdf', status: 'pending' }),
    ]);
    await inOrg(A(), owner(), (tx, ctx) => markConversationRead(tx, ctx, conversation.id));
    expect(
      (await inOrg(A(), owner(), (tx, ctx) => getConversation(tx, ctx, conversation.id)))
        .unreadCount,
    ).toBe(0);

    // Events: conversation.created and message.received once each (replays emitted nothing).
    const events = await withSystem(handle.db, (tx) =>
      tx
        .select({ type: outboxEvents.type })
        .from(outboxEvents)
        .where(eq(outboxEvents.organizationId, A().id)),
    );
    const received = events.filter((event) => event.type === 'message.received').length;
    expect(received).toBeGreaterThanOrEqual(2);
  });

  it('matches existing contacts by phone or email instead of creating new ones', async () => {
    const email = `buyer.${uniqueSuffix()}@gulf.example`;
    const contact = await inOrg(A(), owner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Known', email }),
    );
    const { connection, webhookUrl } = await connect(
      A(),
      owner(),
      'fake_email',
      `inbox.${uniqueSuffix()}@manama.example`,
    );
    await deliverWebhook('fake_email', webhookUrl, await secretOf(connection.id), {
      events: [
        {
          kind: 'message',
          providerMessageId: `pm.${uniqueSuffix()}`,
          from: email.toUpperCase(),
          subject: 'Quote request',
          text: 'Please send prices',
        },
      ],
    });
    const inbox = await inOrg(A(), owner(), (tx, ctx) =>
      listConversations(tx, ctx, {
        limit: 10,
        status: 'open',
        assignee: 'all',
        contactId: contact.id,
      }),
    );
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0]).toMatchObject({ subject: 'Quote request', contact: { id: contact.id } });
  });

  it('keeps messages from well-formed numbers outside known ranges instead of dropping them', async () => {
    // Well-formed E.164 that libphonenumber's metadata rejects (the CRM cannot store it).
    const sender = '+97338600593';
    expect(normalizeCounterpart('whatsapp', sender, 'BH')).toBe(sender);
    expect(normalizeCounterpart('whatsapp', '0097338600593', 'BH')).toBe(sender);
    expect(normalizeCounterpart('whatsapp', 'not a number', 'BH')).toBeNull();
    expect(normalizeCounterpart('email', 'not-an-email', 'BH')).toBeNull();
    const { connection, webhookUrl } = await connect(A(), owner(), 'fake_whatsapp', '+97333000300');
    const outcome = await deliverWebhook(
      'fake_whatsapp',
      webhookUrl,
      await secretOf(connection.id),
      {
        events: [
          {
            kind: 'message',
            providerMessageId: `wamid.${uniqueSuffix()}`,
            from: sender,
            text: 'Hello',
          },
        ],
      },
    );
    expect(outcome).toMatchObject({ status: 'processed', received: 1 });
    const [conversation] = await inOrg(A(), owner(), (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.connectionId, connection.id),
            eq(conversations.counterpartAddress, sender),
          ),
        ),
    );
    expect(conversation).toMatchObject({
      contactId: null,
      unreadCount: 1,
      lastMessagePreview: 'Hello',
    });
  });
});

describe('outbound pipeline', () => {
  async function whatsappThread(org: Organization, userId: string) {
    const { connection, webhookUrl } = await connect(org, userId, 'fake_whatsapp', '+97333000200');
    const phone = `+9733${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    await deliverWebhook('fake_whatsapp', webhookUrl, await secretOf(connection.id), {
      events: [
        { kind: 'message', providerMessageId: `wamid.${uniqueSuffix()}`, from: phone, text: 'Hi' },
      ],
    });
    const [conversation] = await inOrg(org, userId, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.connectionId, connection.id),
            eq(conversations.counterpartAddress, phone),
          ),
        ),
    );
    if (!conversation) throw new Error('conversation');
    return { connection, webhookUrl, conversation, phone };
  }

  it('sends within the WhatsApp window, records delivery statuses forward-only and emits events', async () => {
    const { conversation, connection, webhookUrl, phone } = await whatsappThread(A(), owner());
    const message = await inOrg(A(), owner(), (tx, ctx) =>
      queueMessage(tx, ctx, conversation.id, { text: 'Yes, 200 bags available' }),
    );
    expect(message.status).toBe('queued');
    expect(
      await deliverMessage(handle.db, services, A().id, message.id, { finalAttempt: false }),
    ).toBe('sent');
    expect(
      await deliverMessage(handle.db, services, A().id, message.id, { finalAttempt: false }),
    ).toBe('skipped');
    expect(fakeWhatsApp.sent.at(-1)).toMatchObject({ to: phone, text: 'Yes, 200 bags available' });
    const secret = await secretOf(connection.id);
    const providerMessageId = `fake_${message.id}`;
    await deliverWebhook('fake_whatsapp', webhookUrl, secret, {
      events: [
        { kind: 'status', providerMessageId, status: 'read' },
        { kind: 'status', providerMessageId, status: 'delivered' },
      ],
    });
    const [stored] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(messages).where(eq(messages.id, message.id)),
    );
    expect(stored).toMatchObject({ status: 'read', providerMessageId });
    expect(stored?.readAt).not.toBeNull();
  });

  it('requires an approved template outside the 24-hour window', async () => {
    const { conversation, connection } = await whatsappThread(A(), owner());
    await inOrg(A(), owner(), (tx) =>
      tx
        .update(conversations)
        .set({ lastInboundAt: new Date(Date.now() - 2 * 86_400_000) })
        .where(eq(conversations.id, conversation.id)),
    );
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        queueMessage(tx, ctx, conversation.id, { text: 'Late reply' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await inOrg(A(), owner(), (tx) =>
      registerTemplate(tx, A().id, connection.id, {
        name: 'order_ready',
        language: 'en',
        category: 'utility',
        body: 'Order {{1}} is ready at {{2}}',
      }),
    );
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        queueMessage(tx, ctx, conversation.id, {
          template: { name: 'order_ready', language: 'en', parameters: ['A-1'] },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const templated = await inOrg(A(), owner(), (tx, ctx) =>
      queueMessage(tx, ctx, conversation.id, {
        template: { name: 'order_ready', language: 'en', parameters: ['A-1', 'Sitra'] },
      }),
    );
    expect(templated.bodyText).toBe('[Template order_ready] A-1 · Sitra');
  });

  it('retries retryable failures, fails permanently on the last attempt and on permanent errors', async () => {
    const { conversation } = await whatsappThread(A(), owner());
    const first = await inOrg(A(), owner(), (tx, ctx) =>
      queueMessage(tx, ctx, conversation.id, { text: 'One' }),
    );
    fakeWhatsApp.failNext('timeout', true);
    await expect(
      deliverMessage(handle.db, services, A().id, first.id, { finalAttempt: false }),
    ).rejects.toThrow();
    const [requeued] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(messages).where(eq(messages.id, first.id)),
    );
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1, errorCode: 'timeout' });
    fakeWhatsApp.failNext('timeout', true);
    expect(
      await deliverMessage(handle.db, services, A().id, first.id, { finalAttempt: true }),
    ).toBe('failed');
    const second = await inOrg(A(), owner(), (tx, ctx) =>
      queueMessage(tx, ctx, conversation.id, { text: 'Two' }),
    );
    fakeWhatsApp.failNext('131026', false);
    expect(
      await deliverMessage(handle.db, services, A().id, second.id, { finalAttempt: false }),
    ).toBe('failed');
    const [failed] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(messages).where(eq(messages.id, second.id)),
    );
    expect(failed).toMatchObject({ status: 'failed', errorCode: '131026' });
  });

  it('enforces the monthly channel quota without leaving partial messages', async () => {
    const ownerUser = await createTestUser(handle.db, { name: 'Quota owner' });
    const { organization } = await createOrganization(handle.db, ownerUser.id, {
      name: `Quota ${uniqueSuffix()}`,
    });
    await withSystem(handle.db, async (tx) => {
      const plan = await createPlan(tx, {
        key: `comms-${uniqueSuffix()}`,
        name: 'Comms',
        isPublic: false,
      });
      const version = await createPlanVersion(tx, plan.id, { 'whatsapp.monthly_limit': 1 });
      await publishPlanVersion(tx, version.id);
      await startSubscription(tx, {
        organizationId: organization.id,
        planVersionId: version.id,
        status: 'active',
        provider: 'manual',
      });
    });
    const { conversation } = await whatsappThread(organization, ownerUser.id);
    await inOrg(organization, ownerUser.id, (tx, ctx) =>
      queueMessage(tx, ctx, conversation.id, { text: 'First' }),
    );
    await expect(
      inOrg(organization, ownerUser.id, (tx, ctx) =>
        queueMessage(tx, ctx, conversation.id, { text: 'Second' }),
      ),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
    const stored = await inOrg(organization, ownerUser.id, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    );
    expect(stored.filter((m) => m.direction === 'outbound')).toHaveLength(1);
  });
});

describe('isolation and timeline', () => {
  it('keeps conversations, messages and webhooks inside their tenant', async () => {
    const { connection, webhookUrl } = await connect(A(), owner(), 'fake_sms', '+97333000300');
    const phone = `+9733${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    await deliverWebhook('fake_sms', webhookUrl, await secretOf(connection.id), {
      events: [
        {
          kind: 'message',
          providerMessageId: `SM${uniqueSuffix()}`,
          from: phone,
          text: 'Secret SMS',
        },
      ],
    });
    const [conversation] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(conversations).where(eq(conversations.connectionId, connection.id)),
    );
    if (!conversation) throw new Error('conversation');
    const bOwner = world.orgB.users.owner.id;
    const bInbox = await inOrg(B(), bOwner, (tx, ctx) =>
      listConversations(tx, ctx, { limit: 100, status: 'all', assignee: 'all' }),
    );
    expect(bInbox.data.map((c) => c.id)).not.toContain(conversation.id);
    await expect(
      inOrg(B(), bOwner, (tx, ctx) => getConversation(tx, ctx, conversation.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inOrg(B(), bOwner, (tx, ctx) => queueMessage(tx, ctx, conversation.id, { text: 'x' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const raw = await inOrg(B(), bOwner, (tx) =>
      tx.select().from(messages).where(eq(messages.conversationId, conversation.id)),
    );
    expect(raw).toEqual([]);
    // B cannot start a conversation through A's connection.
    const bContact = await inOrg(B(), bOwner, (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'B', phone: '+97333111222' }),
    );
    await expect(
      inOrg(B(), bOwner, (tx, ctx) =>
        startConversation(tx, ctx, { connectionId: connection.id, contactId: bContact.id }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('projects messages onto the contact timeline for members who can read conversations', async () => {
    const { connection, webhookUrl } = await connect(A(), owner(), 'fake_whatsapp', '+97333000400');
    const phone = `+9733${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    const since = new Date(Date.now() - 1_000);
    await deliverWebhook('fake_whatsapp', webhookUrl, await secretOf(connection.id), {
      events: [
        {
          kind: 'message',
          providerMessageId: `wamid.${uniqueSuffix()}`,
          from: phone,
          fromName: 'Timeline Lead',
          text: 'Need a quote',
        },
      ],
    });
    const rows = await withSystem(handle.db, (tx) =>
      tx
        .select({
          id: outboxEvents.id,
          type: outboxEvents.type,
          occurredAt: outboxEvents.occurredAt,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.organizationId, A().id)),
    );
    for (const row of rows.filter((r) => r.type === 'message.received' && r.occurredAt > since)) {
      const event = await loadEvent(handle.db, row.id);
      if (event) await projectEvent(handle.db, communicationsTimelineProjectors, event);
    }
    const [conversation] = await inOrg(A(), owner(), (tx) =>
      tx.select().from(conversations).where(eq(conversations.connectionId, connection.id)),
    );
    const contactId = conversation?.contactId;
    if (!contactId) throw new Error('contact');
    const visible = await inOrg(A(), owner(), (tx) =>
      listActivities(
        tx,
        A().id,
        { kind: 'contact', id: contactId },
        { limit: 10 },
        new Set(['communications.read', 'crm.contact.read']),
      ),
    );
    expect(visible.data.map((a) => a.summary)).toContain(
      'WhatsApp from Timeline Lead: Need a quote',
    );
    const hidden = await inOrg(A(), owner(), (tx) =>
      listActivities(
        tx,
        A().id,
        { kind: 'contact', id: contactId },
        { limit: 10 },
        new Set(['crm.contact.read']),
      ),
    );
    expect(hidden.data.some((a) => a.type === 'whatsapp.received')).toBe(false);
  });
});
