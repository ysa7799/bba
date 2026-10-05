import { z } from 'zod';
import {
  header,
  WebhookSignatureError,
  type ChannelProvider,
  type NormalizedEvent,
  type OutboundMessage,
  type ResolvedConnection,
  type SendResult,
  type WebhookRequest,
} from '../types';
import {
  isRetryableStatus,
  MessagingProviderError,
  providerFetch,
  requireCredential,
  safeEqual,
} from './util';

const inboundSchema = z.object({
  MessageID: z.string().min(1),
  FromFull: z.object({ Email: z.string(), Name: z.string().nullish() }),
  To: z.string().nullish(),
  Subject: z.string().nullish(),
  TextBody: z.string().nullish(),
  StrippedTextReply: z.string().nullish(),
  Date: z.string().nullish(),
  Attachments: z
    .array(
      z.object({ Name: z.string(), ContentType: z.string(), ContentLength: z.number().nullish() }),
    )
    .nullish(),
});

const recordSchema = z.object({
  RecordType: z.string(),
  MessageID: z.string().min(1),
  DeliveredAt: z.string().nullish(),
  BouncedAt: z.string().nullish(),
  ReceivedAt: z.string().nullish(),
  Type: z.string().nullish(),
  TypeCode: z.number().nullish(),
  Description: z.string().nullish(),
});

function date(value: string | null | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Postmark (transactional + inbound email). Outbound via the Email API with the connection's
 * server token. Postmark does not sign webhooks: authenticity comes from the unguessable
 * per-connection URL plus HTTP Basic credentials configured on the Postmark webhook.
 */
export class PostmarkEmailProvider implements ChannelProvider {
  readonly key = 'postmark';
  readonly channel = 'email' as const;
  readonly label = 'Postmark';
  readonly credentialFields = [
    { key: 'serverToken', label: 'Server API token', secret: true },
    { key: 'webhookUsername', label: 'Webhook username', secret: false },
    { key: 'webhookPassword', label: 'Webhook password', secret: true },
  ] as const;
  readonly credentialsSchema = z.object({
    serverToken: z.string().min(10).max(200),
    webhookUsername: z.string().min(3).max(100),
    webhookPassword: z.string().min(12).max(200),
  });
  readonly requiresExternalAccountId = false;

  constructor(private readonly options: { fetch?: typeof fetch; baseUrl?: string } = {}) {}

  async send(connection: ResolvedConnection, message: OutboundMessage): Promise<SendResult> {
    const token = requireCredential(connection.credentials, 'serverToken', this.key);
    const stream =
      typeof connection.settings.messageStream === 'string'
        ? connection.settings.messageStream
        : 'outbound';
    const response = await providerFetch(
      this.key,
      this.options.fetch ?? fetch,
      `${this.options.baseUrl ?? 'https://api.postmarkapp.com'}/email`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': token,
        },
        body: JSON.stringify({
          From: connection.address,
          To: message.to,
          Subject: message.subject ?? '',
          TextBody: message.text,
          MessageStream: stream,
          Metadata: { businessosMessageId: message.id },
          ...(message.replyToProviderMessageId
            ? { Headers: [{ Name: 'In-Reply-To', Value: `<${message.replyToProviderMessageId}>` }] }
            : {}),
        }),
      },
    );
    const body = (response.body ?? {}) as { MessageID?: unknown; ErrorCode?: unknown };
    if (!response.ok || typeof body.MessageID !== 'string') {
      throw new MessagingProviderError(
        this.key,
        `Postmark rejected the message (HTTP ${response.status})`,
        {
          retryable: isRetryableStatus(response.status),
          providerCode: typeof body.ErrorCode === 'number' ? String(body.ErrorCode) : null,
        },
      );
    }
    return { providerMessageId: body.MessageID, status: 'sent' };
  }

  parseWebhook(connection: ResolvedConnection, request: WebhookRequest): NormalizedEvent[] {
    const expected = Buffer.from(
      `${connection.credentials.webhookUsername ?? ''}:${connection.credentials.webhookPassword ?? ''}`,
    ).toString('base64');
    const provided = header(request.headers, 'authorization') ?? '';
    if (!connection.credentials.webhookPassword || !safeEqual(provided, `Basic ${expected}`)) {
      throw new WebhookSignatureError();
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Malformed webhook payload');
    }
    const record = recordSchema.safeParse(json);
    if (record.success && record.data.RecordType !== 'Inbound') {
      const r = record.data;
      switch (r.RecordType) {
        case 'Delivery':
          return [
            {
              kind: 'status',
              providerMessageId: r.MessageID,
              status: 'delivered',
              timestamp: date(r.DeliveredAt),
              error: null,
            },
          ];
        case 'Open':
          return [
            {
              kind: 'status',
              providerMessageId: r.MessageID,
              status: 'read',
              timestamp: date(r.ReceivedAt),
              error: null,
            },
          ];
        case 'Bounce':
        case 'SpamComplaint':
          return [
            {
              kind: 'status',
              providerMessageId: r.MessageID,
              status: 'failed',
              timestamp: date(r.BouncedAt),
              error: {
                code: r.Type ?? r.RecordType,
                message: (r.Description ?? 'Delivery failed').slice(0, 500),
              },
            },
          ];
        default:
          return [];
      }
    }
    const inbound = inboundSchema.safeParse(json);
    if (!inbound.success) throw new WebhookSignatureError('Unrecognized webhook payload');
    const m = inbound.data;
    return [
      {
        kind: 'message',
        providerMessageId: m.MessageID,
        from: m.FromFull.Email,
        fromName: m.FromFull.Name ?? null,
        to: m.To ?? null,
        subject: m.Subject ?? null,
        text: (m.StrippedTextReply ?? m.TextBody ?? '').slice(0, 65_536),
        timestamp: date(m.Date),
        attachments: (m.Attachments ?? []).slice(0, 20).map((attachment) => ({
          fileName: attachment.Name.slice(0, 255) || 'attachment',
          contentType: attachment.ContentType.slice(0, 200),
          sizeBytes: attachment.ContentLength ?? null,
          providerMediaId: null,
        })),
      },
    ];
  }
}
