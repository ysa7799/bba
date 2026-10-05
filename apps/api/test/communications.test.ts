import { FakeChannelProvider } from '@businessos/communications';
import { channelConnections, withSystem } from '@businessos/database';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let devCtx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }, context = ctx): Promise<TestClient> {
  const key = `${context === ctx ? 'main' : 'dev'}:${user.id}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const client = await loginAs(context, user);
  clients.set(key, client);
  return client;
}

const comms = (orgId: string, path: string) => `/app/orgs/${orgId}/communications${path}`;

beforeAll(async () => {
  ctx = await createTestContext();
  devCtx = await createTestContext({ env: { COMMUNICATIONS_FAKE_PROVIDERS: 'true' } });
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
  await devCtx.close();
});

async function createWhatsAppChannel(client: TestClient, orgId: string) {
  const response = await client.post(comms(orgId, '/channels'), {
    provider: 'fake_whatsapp',
    name: `WhatsApp ${uniqueSuffix()}`,
    address: '3300 0500',
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ connection: { id: string; address: string }; webhookUrl: string }>();
}

/** Signs a fake provider payload with the connection's stored secret (test-only lookup). */
async function signedWebhook(
  context: TestContext,
  connectionId: string,
  webhookUrl: string,
  events: unknown[],
) {
  // System scope: the test reads sealed credentials to act as the provider.
  const [row] = await withSystem(context.db.db, (tx) =>
    tx.select().from(channelConnections).where(eq(channelConnections.id, connectionId)),
  );
  if (!row) throw new Error('connection');
  const { resolveConnection } = await import('@businessos/communications');
  const secret = resolveConnection(context.app.communications, row).credentials.webhookSecret ?? '';
  const body = JSON.stringify({ events });
  const path = new URL(webhookUrl).pathname;
  return {
    path,
    body,
    signature: FakeChannelProvider.sign(body, secret),
  };
}

describe('channels', () => {
  it('lets admins connect channels, hides configuration from other members and isolates tenants', async () => {
    const owner = await as(world.orgA.users.owner);
    const { connection, webhookUrl } = await createWhatsAppChannel(owner, A);
    expect(connection.address).toBe('+97333000500');
    expect(webhookUrl).toContain('/webhooks/communications/fake_whatsapp/');

    const sales = await as(world.orgA.users.sales);
    const listed = (await sales.get(comms(A, '/channels')))
      .json()
      .data.find((c: { id: string }) => c.id === connection.id);
    expect(listed).toEqual({
      id: connection.id,
      channel: 'whatsapp',
      provider: 'fake_whatsapp',
      providerLabel: expect.any(String),
      name: expect.any(String),
      address: '+97333000500',
      status: 'active',
    });
    expect(
      (
        await sales.post(comms(A, '/channels'), {
          provider: 'fake_sms',
          name: 'x',
          address: '+97333000600',
        })
      ).statusCode,
    ).toBe(403);
    expect((await sales.get(comms(A, '/channels/providers'))).statusCode).toBe(403);
    const providers = (await owner.get(comms(A, '/channels/providers'))).json();
    expect(providers.encryptionConfigured).toBe(true);
    expect(providers.data.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(['postmark', 'whatsapp_cloud', 'twilio']),
    );

    const bAdmin = await as(world.orgB.users.admin);
    expect(JSON.stringify((await bAdmin.get(comms(B, '/channels'))).json())).not.toContain(
      connection.id,
    );
    expect(
      (await bAdmin.patch(comms(B, `/channels/${connection.id}`), { name: 'Hijack' })).statusCode,
    ).toBe(404);
    expect((await bAdmin.delete(comms(B, `/channels/${connection.id}`))).statusCode).toBe(404);
    expect(
      (await bAdmin.post(comms(B, `/channels/${connection.id}/rotate-webhook`), {})).statusCode,
    ).toBe(404);

    // Secret credentials are write-only.
    const postmark = await owner.post(comms(A, '/channels'), {
      provider: 'postmark',
      name: 'Email',
      address: `support.${uniqueSuffix()}@manama.example`,
      credentials: {
        serverToken: 'postmark-server-token',
        webhookUsername: 'postmark-hooks',
        webhookPassword: 'webhook-password-123',
      },
    });
    expect(postmark.statusCode, postmark.body).toBe(201);
    expect(postmark.body).not.toContain('postmark-server-token');
    expect(postmark.body).not.toContain('webhook-password-123');
    const audit = (
      await owner.get(`/app/orgs/${A}/audit-logs?action=communications.channel.connected`)
    ).json().data;
    expect(JSON.stringify(audit)).not.toContain('postmark-server-token');
  });
});

describe('webhooks and inbox', () => {
  it('accepts only signed webhooks on a known token and feeds a tenant-isolated inbox', async () => {
    const owner = await as(world.orgA.users.owner);
    const { connection, webhookUrl } = await createWhatsAppChannel(owner, A);
    const phone = `+9733${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    const events = [
      {
        kind: 'message',
        providerMessageId: `wamid.${uniqueSuffix()}`,
        from: phone,
        fromName: 'Webhook Lead',
        text: 'Price for 50 bags?',
      },
    ];
    const signed = await signedWebhook(ctx, connection.id, webhookUrl, events);

    const forged = await ctx.app.inject({
      method: 'POST',
      url: signed.path,
      payload: signed.body,
      headers: { 'content-type': 'application/json', 'x-fake-signature': 'nope' },
    });
    expect(forged.statusCode).toBe(401);
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/communications/fake_whatsapp/${'a'.repeat(43)}`,
      payload: signed.body,
      headers: { 'content-type': 'application/json', 'x-fake-signature': signed.signature },
    });
    expect(unknown.statusCode).toBe(404);
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: signed.path,
      payload: signed.body,
      headers: { 'content-type': 'text/plain', 'x-fake-signature': signed.signature },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ received: true });

    const restricted = await as(world.orgA.users.restricted);
    const inbox = (
      await restricted.get(comms(A, `/conversations?q=${encodeURIComponent(phone)}`))
    ).json().data;
    expect(inbox).toHaveLength(1);
    const conversation = inbox[0];
    expect(conversation).toMatchObject({
      unreadCount: 1,
      lastMessagePreview: 'Price for 50 bags?',
      canReplyFreely: true,
    });
    expect(
      (await restricted.get(comms(A, '/conversations/unread-count'))).json().unread,
    ).toBeGreaterThanOrEqual(1);
    const thread = (
      await restricted.get(comms(A, `/conversations/${conversation.id}/messages`))
    ).json().data;
    expect(thread[0]).toMatchObject({ direction: 'inbound', text: 'Price for 50 bags?' });

    // Restricted members read but cannot reply, note or assign.
    expect(
      (await restricted.post(comms(A, `/conversations/${conversation.id}/messages`), { text: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await restricted.post(comms(A, `/conversations/${conversation.id}/notes`), { text: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await restricted.patch(comms(A, `/conversations/${conversation.id}`), { status: 'closed' }))
        .statusCode,
    ).toBe(403);

    const sales = await as(world.orgA.users.sales);
    const reply = await sales.post(comms(A, `/conversations/${conversation.id}/messages`), {
      text: 'BHD 1.250 per bag',
    });
    expect(reply.statusCode).toBe(202);
    const messageId = reply.json().message.id as string;
    expect(
      ctx.jobs
        .ofType('communications.send')
        .some(
          (job) => job.payload.messageId === messageId && job.options.jobId === `msg-${messageId}`,
        ),
    ).toBe(true);
    expect(
      (
        await sales.post(comms(A, `/conversations/${conversation.id}/notes`), {
          text: 'Asked for delivery to Sitra',
        })
      ).statusCode,
    ).toBe(201);
    const tag = (
      await owner.post(`/app/orgs/${A}/crm/tags`, { name: `Hot ${uniqueSuffix()}` })
    ).json().tag;
    const patched = await sales.patch(comms(A, `/conversations/${conversation.id}`), {
      assigneeUserId: world.orgA.users.sales.id,
      status: 'closed',
      tagIds: [tag.id],
    });
    expect(patched.json().conversation).toMatchObject({
      status: 'closed',
      assignee: { userId: world.orgA.users.sales.id },
      tags: [{ id: tag.id }],
    });
    expect(
      (await sales.post(comms(A, `/conversations/${conversation.id}/read`), {})).statusCode,
    ).toBe(204);

    // Other tenant: nothing visible, nothing writable.
    const bAdmin = await as(world.orgB.users.admin);
    expect(
      JSON.stringify((await bAdmin.get(comms(B, '/conversations?status=all'))).json()),
    ).not.toContain(conversation.id);
    for (const [method, path, body] of [
      ['GET', `/conversations/${conversation.id}`, undefined],
      ['GET', `/conversations/${conversation.id}/messages`, undefined],
      ['POST', `/conversations/${conversation.id}/messages`, { text: 'x' }],
      ['POST', `/conversations/${conversation.id}/notes`, { text: 'x' }],
      ['POST', `/conversations/${conversation.id}/read`, {}],
      ['PATCH', `/conversations/${conversation.id}`, { status: 'open' }],
    ] as const) {
      expect(
        (await bAdmin.request(method, comms(B, path), body)).statusCode,
        `${method} ${path}`,
      ).toBe(404);
    }
    expect(
      (
        await bAdmin.patch(comms(B, `/conversations/${conversation.id}`), {
          assigneeUserId: world.orgB.users.admin.id,
        })
      ).statusCode,
    ).toBe(404);
    // Assigning to a member of another organization is rejected.
    expect(
      (
        await sales.patch(comms(A, `/conversations/${conversation.id}`), {
          assigneeUserId: world.orgB.users.admin.id,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('starts outbound conversations from contacts and validates input', async () => {
    const owner = await as(world.orgA.users.owner);
    const { connection } = await createWhatsAppChannel(owner, A);
    const contact = (
      await owner.post(`/app/orgs/${A}/crm/contacts`, { firstName: 'Outbound', phone: '3355 6677' })
    ).json().contact;
    const started = await owner.post(comms(A, '/conversations'), {
      connectionId: connection.id,
      contactId: contact.id,
    });
    expect(started.statusCode).toBe(201);
    expect(started.json().conversation).toMatchObject({
      counterpart: { address: '+97333556677' },
      canReplyFreely: false,
    });
    // No customer message in the last 24 hours: free text is refused on WhatsApp.
    const refused = await owner.post(
      comms(A, `/conversations/${started.json().conversation.id}/messages`),
      { text: 'Hi!' },
    );
    expect(refused.statusCode).toBe(409);
    expect(
      (
        await owner.post(comms(A, `/conversations/${started.json().conversation.id}/messages`), {
          text: '',
        })
      ).statusCode,
    ).toBe(400);
    const again = await owner.post(comms(A, '/conversations'), {
      connectionId: connection.id,
      contactId: contact.id,
    });
    expect(again.statusCode).toBe(200);
  });
});

describe('development simulator', () => {
  it('is only mounted when fake providers are enabled and still verifies signatures', async () => {
    const owner = await as(world.orgA.users.owner);
    const { connection } = await createWhatsAppChannel(owner, A);
    expect(
      (
        await owner.post(`/app/dev/communications/${A}/channels/${connection.id}/inbound`, {
          from: '+97333000999',
          text: 'hi',
        })
      ).statusCode,
    ).toBe(404);
    const devOwner = await as(world.orgA.users.owner, devCtx);
    const devChannel = await createWhatsAppChannel(devOwner, A);
    const simulated = await devOwner.post(
      `/app/dev/communications/${A}/channels/${devChannel.connection.id}/inbound`,
      {
        from: '+97333000999',
        fromName: 'Simulated',
        text: 'Testing',
      },
    );
    expect(simulated.statusCode).toBe(200);
    expect(simulated.json().outcome).toMatchObject({ status: 'processed', received: 1 });
    const sales = await as(world.orgA.users.sales, devCtx);
    expect(
      (
        await sales.post(
          `/app/dev/communications/${A}/channels/${devChannel.connection.id}/inbound`,
          { from: '+97333000999', text: 'x' },
        )
      ).statusCode,
    ).toBe(403);
    const bAdmin = await as(world.orgB.users.admin, devCtx);
    expect(
      (
        await bAdmin.post(
          `/app/dev/communications/${B}/channels/${devChannel.connection.id}/inbound`,
          { from: '+97333000999', text: 'x' },
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('webhook logging', () => {
  it('never writes webhook routing tokens or verify tokens to the logs', async () => {
    const lines: string[] = [];
    const logged = await createTestContext({
      env: { LOG_LEVEL: 'info' },
      logStream: { write: (line) => void lines.push(line) },
    });
    try {
      // This instance has its own encryption key: create the channel through it.
      const owner = await loginAs(logged, world.orgA.users.owner);
      const { connection, webhookUrl } = await createWhatsAppChannel(owner, A);
      const token = new URL(webhookUrl).pathname.split('/').at(-1) ?? '';
      expect(token.length).toBeGreaterThan(30);
      const signed = await signedWebhook(logged, connection.id, webhookUrl, []);
      const posted = await logged.app.inject({
        method: 'POST',
        url: signed.path,
        payload: signed.body,
        headers: { 'content-type': 'application/json', 'x-fake-signature': signed.signature },
      });
      expect(posted.statusCode).toBe(200);
      await logged.app.inject({
        method: 'GET',
        url: `${signed.path}?hub.mode=subscribe&hub.verify_token=verify-secret-value&hub.challenge=1`,
      });
      const output = lines.join('');
      expect(output).toContain('/webhooks/communications/fake_whatsapp/[REDACTED]');
      expect(output).not.toContain(token);
      expect(output).not.toContain('verify-secret-value');
    } finally {
      await logged.close();
    }
  });
});
