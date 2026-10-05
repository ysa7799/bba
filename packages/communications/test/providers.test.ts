import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeChannelProvider,
  MessagingProviderError,
  PostmarkEmailProvider,
  TwilioSmsProvider,
  twilioSignature,
  WebhookSignatureError,
  WhatsAppCloudProvider,
  type ResolvedConnection,
  type WebhookRequest,
} from '../src';

function connection(overrides: Partial<ResolvedConnection>): ResolvedConnection {
  return {
    id: 'conn',
    organizationId: 'org',
    channel: 'email',
    address: 'support@manama.example',
    externalAccountId: null,
    credentials: {},
    settings: {},
    webhookUrl: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function request(
  body: string,
  headers: Record<string, string> = {},
  url = 'https://api.example.com/hook',
  query = {},
): WebhookRequest {
  return { rawBody: Buffer.from(body), headers, url, query };
}

describe('Postmark', () => {
  const creds = {
    serverToken: 'server-token-123',
    webhookUsername: 'postmark',
    webhookPassword: 'very-long-password',
  };
  const conn = connection({ credentials: creds });

  it('sends with the server token and returns the MessageID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ MessageID: 'pm-1', ErrorCode: 0 }));
    const provider = new PostmarkEmailProvider({ fetch: fetchMock });
    const result = await provider.send(conn, {
      id: 'm1',
      to: 'a@b.example',
      from: conn.address,
      subject: 'Hi',
      text: 'Hello',
      replyToProviderMessageId: 'abc@pm',
    });
    expect(result).toEqual({ providerMessageId: 'pm-1', status: 'sent' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect((init.headers as Record<string, string>)['x-postmark-server-token']).toBe(
      'server-token-123',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      From: 'support@manama.example',
      To: 'a@b.example',
      TextBody: 'Hello',
      Headers: [{ Name: 'In-Reply-To', Value: '<abc@pm>' }],
    });
  });

  it('maps failures to provider errors with codes and retryability', async () => {
    const rejected = new PostmarkEmailProvider({
      fetch: vi.fn().mockResolvedValue(json({ ErrorCode: 300, Message: 'Invalid' }, 422)),
    });
    const error = await rejected
      .send(conn, { id: 'm', to: 'x@y.example', from: 'a', text: 't' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MessagingProviderError);
    expect((error as MessagingProviderError).retryable).toBe(false);
    expect((error as MessagingProviderError).providerCode).toBe('300');
    const down = new PostmarkEmailProvider({
      fetch: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    expect(
      (
        (await down
          .send(conn, { id: 'm', to: 'x', from: 'a', text: 't' })
          .catch((e: unknown) => e)) as MessagingProviderError
      ).retryable,
    ).toBe(true);
    const unconfigured = new PostmarkEmailProvider({ fetch: vi.fn() });
    await expect(
      unconfigured.send(connection({}), { id: 'm', to: 'x', from: 'a', text: 't' }),
    ).rejects.toThrow(/CONFIGURATION_REQUIRED/);
  });

  it('requires the webhook basic credentials and normalizes inbound, delivery and bounce records', () => {
    const provider = new PostmarkEmailProvider();
    const auth = {
      authorization: `Basic ${Buffer.from('postmark:very-long-password').toString('base64')}`,
    };
    const inbound = JSON.stringify({
      MessageID: 'in-1',
      FromFull: { Email: 'Fatima@Example.com', Name: 'Fatima' },
      To: 'support@manama.example',
      Subject: 'Quote',
      TextBody: 'Full text',
      StrippedTextReply: 'Reply only',
      Attachments: [{ Name: 'po.pdf', ContentType: 'application/pdf', ContentLength: 1200 }],
    });
    expect(() => provider.parseWebhook(conn, request(inbound))).toThrow(WebhookSignatureError);
    expect(() =>
      provider.parseWebhook(
        conn,
        request(inbound, {
          authorization: `Basic ${Buffer.from('postmark:wrong').toString('base64')}`,
        }),
      ),
    ).toThrow(WebhookSignatureError);
    expect(provider.parseWebhook(conn, request(inbound, auth))).toEqual([
      expect.objectContaining({
        kind: 'message',
        providerMessageId: 'in-1',
        from: 'Fatima@Example.com',
        fromName: 'Fatima',
        text: 'Reply only',
        attachments: [
          {
            fileName: 'po.pdf',
            contentType: 'application/pdf',
            sizeBytes: 1200,
            providerMediaId: null,
          },
        ],
      }),
    ]);
    expect(
      provider.parseWebhook(
        conn,
        request(
          JSON.stringify({
            RecordType: 'Delivery',
            MessageID: 'pm-1',
            DeliveredAt: '2026-10-05T10:00:00Z',
          }),
          auth,
        ),
      ),
    ).toEqual([
      expect.objectContaining({ kind: 'status', providerMessageId: 'pm-1', status: 'delivered' }),
    ]);
    expect(
      provider.parseWebhook(
        conn,
        request(
          JSON.stringify({
            RecordType: 'Bounce',
            MessageID: 'pm-1',
            Type: 'HardBounce',
            Description: 'No mailbox',
          }),
          auth,
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: { code: 'HardBounce', message: 'No mailbox' },
      }),
    ]);
  });
});

describe('WhatsApp Cloud API', () => {
  const creds = {
    accessToken: 'EAAG-access-token-0123456789',
    appSecret: 'app-secret-0123456789',
    verifyToken: 'verify-token-0123456789',
  };
  const conn = connection({
    channel: 'whatsapp',
    address: '+97333000000',
    externalAccountId: '1234567890',
    credentials: creds,
  });

  it('sends text and template messages to the phone number id', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(json({ messages: [{ id: 'wamid.1' }] })));
    const provider = new WhatsAppCloudProvider({ fetch: fetchMock });
    await provider.send(conn, { id: 'm1', to: '+97333123456', from: conn.address, text: 'Hello' });
    await provider.send(conn, {
      id: 'm2',
      to: '+97333123456',
      from: conn.address,
      text: '',
      template: { name: 'order_update', language: 'ar', parameters: ['A-1'] },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${creds.accessToken}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: '97333123456',
      type: 'text',
      text: { body: 'Hello' },
    });
    expect(
      JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string),
    ).toMatchObject({
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'A-1' }] }],
      },
    });
    const outside = new WhatsAppCloudProvider({
      fetch: vi.fn().mockResolvedValue(json({ error: { code: 131047 } }, 400)),
    });
    const error = (await outside
      .send(conn, { id: 'm', to: '+973', from: 'x', text: 'late' })
      .catch((e: unknown) => e)) as MessagingProviderError;
    expect(error.providerCode).toBe('131047');
    expect(error.retryable).toBe(false);
  });

  it('answers the subscription handshake only with the right verify token', () => {
    const provider = new WhatsAppCloudProvider();
    expect(
      provider.verifySubscription(conn, {
        'hub.mode': 'subscribe',
        'hub.verify_token': creds.verifyToken,
        'hub.challenge': '42',
      }),
    ).toBe('42');
    expect(
      provider.verifySubscription(conn, {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'nope',
        'hub.challenge': '42',
      }),
    ).toBeNull();
  });

  it('verifies X-Hub-Signature-256 and normalizes messages and statuses for its own number only', () => {
    const provider = new WhatsAppCloudProvider();
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '1234567890' },
                contacts: [{ wa_id: '97333123456', profile: { name: 'Ali' } }],
                messages: [
                  {
                    from: '97333123456',
                    id: 'wamid.in',
                    timestamp: '1791180000',
                    type: 'text',
                    text: { body: 'مرحبا' },
                  },
                  {
                    from: '97333123456',
                    id: 'wamid.img',
                    timestamp: '1791180001',
                    type: 'image',
                    image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'invoice' },
                  },
                ],
                statuses: [
                  {
                    id: 'wamid.out',
                    status: 'failed',
                    timestamp: '1791180002',
                    errors: [{ code: 131047, title: 'Re-engagement message' }],
                  },
                ],
              },
            },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'other' },
                messages: [
                  { from: '1', id: 'x', timestamp: '1', type: 'text', text: { body: 'not ours' } },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac('sha256', creds.appSecret).update(payload).digest('hex')}`;
    expect(() =>
      provider.parseWebhook(conn, request(payload, { 'x-hub-signature-256': 'sha256=deadbeef' })),
    ).toThrow(WebhookSignatureError);
    const events = provider.parseWebhook(
      conn,
      request(payload, { 'x-hub-signature-256': signature }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'message',
        providerMessageId: 'wamid.in',
        from: '+97333123456',
        fromName: 'Ali',
        text: 'مرحبا',
      }),
      expect.objectContaining({
        kind: 'message',
        providerMessageId: 'wamid.img',
        text: 'invoice',
        attachments: [
          expect.objectContaining({ providerMediaId: 'media-1', contentType: 'image/jpeg' }),
        ],
      }),
      expect.objectContaining({
        kind: 'status',
        providerMessageId: 'wamid.out',
        status: 'failed',
        error: { code: '131047', message: 'Re-engagement message' },
      }),
    ]);
  });
});

describe('Twilio SMS', () => {
  const creds = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'twilio-auth-token-0123' };
  const conn = connection({
    channel: 'sms',
    address: '+97333000001',
    credentials: creds,
    webhookUrl: 'https://api.example.com/webhooks/communications/twilio/tok',
  });

  it('sends form-encoded with basic auth and a status callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sid: 'SM1', status: 'queued' }, 201));
    const result = await new TwilioSmsProvider({ fetch: fetchMock }).send(conn, {
      id: 'm',
      to: '+97333123456',
      from: conn.address,
      text: 'Code 1234',
    });
    expect(result).toEqual({ providerMessageId: 'SM1', status: 'queued' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
    );
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      To: '+97333123456',
      Body: 'Code 1234',
      From: '+97333000001',
      StatusCallback: conn.webhookUrl,
    });
  });

  it('verifies X-Twilio-Signature over the URL and parameters', () => {
    const provider = new TwilioSmsProvider();
    const params = {
      MessageSid: 'SM9',
      From: '+97333123456',
      To: '+97333000001',
      Body: 'Yes please',
      NumMedia: '0',
    };
    const body = new URLSearchParams(params).toString();
    const url = conn.webhookUrl ?? '';
    const good = twilioSignature(creds.authToken, url, params);
    expect(provider.parseWebhook(conn, request(body, { 'x-twilio-signature': good }, url))).toEqual(
      [
        expect.objectContaining({
          kind: 'message',
          providerMessageId: 'SM9',
          from: '+97333123456',
          text: 'Yes please',
        }),
      ],
    );
    expect(() =>
      provider.parseWebhook(conn, request(body, { 'x-twilio-signature': good }, `${url}?x=1`)),
    ).toThrow(WebhookSignatureError);
    const status = { MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '30003' };
    expect(
      provider.parseWebhook(
        conn,
        request(
          new URLSearchParams(status).toString(),
          { 'x-twilio-signature': twilioSignature(creds.authToken, url, status) },
          url,
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'status',
        status: 'failed',
        error: { code: '30003', message: 'Twilio error 30003' },
      }),
    ]);
  });
});

describe('fake provider', () => {
  it('signs and verifies its own payloads and can simulate failures', async () => {
    const provider = new FakeChannelProvider('whatsapp');
    const conn = connection({
      channel: 'whatsapp',
      credentials: { webhookSecret: 'fake-secret-0123456789' },
    });
    const body = JSON.stringify({
      events: [{ kind: 'message', providerMessageId: 'f1', from: '+97333123456', text: 'hi' }],
    });
    expect(
      provider.parseWebhook(
        conn,
        request(body, {
          'x-fake-signature': FakeChannelProvider.sign(body, 'fake-secret-0123456789'),
        }),
      ),
    ).toHaveLength(1);
    expect(() => provider.parseWebhook(conn, request(body, { 'x-fake-signature': 'x' }))).toThrow(
      WebhookSignatureError,
    );
    provider.failNext('boom', true);
    await expect(
      provider.send(conn, { id: 'm', to: 'x', from: 'y', text: 't' }),
    ).rejects.toMatchObject({ retryable: true, providerCode: 'boom' });
    await expect(provider.send(conn, { id: 'm', to: 'x', from: 'y', text: 't' })).resolves.toEqual({
      providerMessageId: 'fake_m',
      status: 'sent',
    });
  });
});
