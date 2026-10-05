import { z } from 'zod';
import {
  header,
  WebhookSignatureError,
  type ChannelProvider,
  type InboundAttachment,
  type NormalizedEvent,
  type OutboundMessage,
  type ResolvedConnection,
  type SendResult,
  type WebhookRequest,
} from '../types';
import {
  hmacHex,
  isRetryableStatus,
  MessagingProviderError,
  providerFetch,
  requireCredential,
  safeEqual,
} from './util';

const mediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().nullish(),
  filename: z.string().nullish(),
  caption: z.string().nullish(),
});

const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).nullish(),
    image: mediaSchema.nullish(),
    document: mediaSchema.nullish(),
    audio: mediaSchema.nullish(),
    video: mediaSchema.nullish(),
    sticker: mediaSchema.nullish(),
    button: z.object({ text: z.string() }).nullish(),
    interactive: z
      .object({
        button_reply: z.object({ title: z.string() }).nullish(),
        list_reply: z.object({ title: z.string() }).nullish(),
      })
      .nullish(),
    location: z
      .object({ latitude: z.number(), longitude: z.number(), name: z.string().nullish() })
      .nullish(),
  })
  .loose();

const statusSchema = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  errors: z
    .array(
      z.object({ code: z.number(), title: z.string().nullish(), message: z.string().nullish() }),
    )
    .nullish(),
});

const payloadSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              metadata: z.object({ phone_number_id: z.string() }).nullish(),
              contacts: z
                .array(
                  z.object({
                    wa_id: z.string(),
                    profile: z.object({ name: z.string() }).nullish(),
                  }),
                )
                .nullish(),
              messages: z.array(messageSchema).nullish(),
              statuses: z.array(statusSchema).nullish(),
            })
            .loose(),
        }),
      ),
    }),
  ),
});

function unixDate(value: string): Date {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}

function toE164(waId: string): string {
  return `+${waId.replace(/\D/g, '')}`;
}

/**
 * WhatsApp Business Cloud API (Meta). Outbound text within the 24-hour customer service window
 * and approved templates outside it; webhooks verified with `X-Hub-Signature-256` (HMAC-SHA256 of
 * the raw body with the app secret) and the GET `hub.verify_token` handshake. Events for other
 * phone numbers of the same app are ignored.
 */
export class WhatsAppCloudProvider implements ChannelProvider {
  readonly key = 'whatsapp_cloud';
  readonly channel = 'whatsapp' as const;
  readonly label = 'WhatsApp Business (Cloud API)';
  readonly credentialFields = [
    { key: 'accessToken', label: 'Access token', secret: true },
    { key: 'appSecret', label: 'App secret', secret: true },
    { key: 'verifyToken', label: 'Webhook verify token', secret: true },
  ] as const;
  readonly credentialsSchema = z.object({
    accessToken: z.string().min(20).max(1_000),
    appSecret: z.string().min(16).max(200),
    verifyToken: z.string().min(16).max(200),
  });
  readonly requiresExternalAccountId = true;

  constructor(
    private readonly options: { fetch?: typeof fetch; baseUrl?: string; apiVersion?: string } = {},
  ) {}

  async send(connection: ResolvedConnection, message: OutboundMessage): Promise<SendResult> {
    const token = requireCredential(connection.credentials, 'accessToken', this.key);
    if (!connection.externalAccountId) {
      throw new MessagingProviderError(this.key, 'WhatsApp phone number id is missing', {
        retryable: false,
        providerCode: 'configuration_required',
      });
    }
    const to = message.to.replace(/\D/g, '');
    const body = message.template
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: message.template.name,
            language: { code: message.template.language },
            components:
              message.template.parameters.length > 0
                ? [
                    {
                      type: 'body',
                      parameters: message.template.parameters.map((text) => ({
                        type: 'text',
                        text,
                      })),
                    },
                  ]
                : [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: message.text },
        };
    const version = this.options.apiVersion ?? 'v21.0';
    const response = await providerFetch(
      this.key,
      this.options.fetch ?? fetch,
      `${this.options.baseUrl ?? 'https://graph.facebook.com'}/${version}/${encodeURIComponent(connection.externalAccountId)}/messages`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const result = (response.body ?? {}) as {
      messages?: { id?: unknown }[];
      error?: { code?: unknown };
    };
    const id = result.messages?.[0]?.id;
    if (!response.ok || typeof id !== 'string') {
      throw new MessagingProviderError(
        this.key,
        `WhatsApp rejected the message (HTTP ${response.status})`,
        {
          retryable: isRetryableStatus(response.status),
          providerCode: typeof result.error?.code === 'number' ? String(result.error.code) : null,
        },
      );
    }
    return { providerMessageId: id, status: 'sent' };
  }

  verifySubscription(
    connection: ResolvedConnection,
    query: Record<string, string | undefined>,
  ): string | null {
    const expected = connection.credentials.verifyToken;
    if (
      query['hub.mode'] !== 'subscribe' ||
      !expected ||
      !query['hub.verify_token'] ||
      !query['hub.challenge']
    ) {
      return null;
    }
    return safeEqual(query['hub.verify_token'], expected) ? query['hub.challenge'] : null;
  }

  parseWebhook(connection: ResolvedConnection, request: WebhookRequest): NormalizedEvent[] {
    const secret = connection.credentials.appSecret;
    const signature = header(request.headers, 'x-hub-signature-256') ?? '';
    if (!secret || !safeEqual(signature, `sha256=${hmacHex('sha256', secret, request.rawBody)}`)) {
      throw new WebhookSignatureError();
    }
    let payload: z.infer<typeof payloadSchema>;
    try {
      payload = payloadSchema.parse(JSON.parse(request.rawBody.toString('utf8')));
    } catch {
      throw new WebhookSignatureError('Malformed webhook payload');
    }
    const events: NormalizedEvent[] = [];
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        if (
          change.field !== 'messages' ||
          value.metadata?.phone_number_id !== connection.externalAccountId
        )
          continue;
        const names = new Map(
          (value.contacts ?? []).map((contact) => [contact.wa_id, contact.profile?.name ?? null]),
        );
        for (const message of value.messages ?? []) {
          const media =
            message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
          const attachments: InboundAttachment[] = media
            ? [
                {
                  fileName: (media.filename ?? `${message.type}-${media.id}`).slice(0, 255),
                  contentType: media.mime_type ?? 'application/octet-stream',
                  sizeBytes: null,
                  providerMediaId: media.id,
                },
              ]
            : [];
          const text =
            message.text?.body ??
            media?.caption ??
            message.button?.text ??
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title ??
            (message.location
              ? `Location: ${message.location.name ? `${message.location.name} ` : ''}(${message.location.latitude}, ${message.location.longitude})`
              : '');
          events.push({
            kind: 'message',
            providerMessageId: message.id,
            from: toE164(message.from),
            fromName: names.get(message.from) ?? null,
            to: connection.address,
            subject: null,
            text: text.slice(0, 65_536),
            timestamp: unixDate(message.timestamp),
            attachments,
          });
        }
        for (const status of value.statuses ?? []) {
          if (!['sent', 'delivered', 'read', 'failed'].includes(status.status)) continue;
          const error = status.errors?.[0];
          events.push({
            kind: 'status',
            providerMessageId: status.id,
            status: status.status as 'sent' | 'delivered' | 'read' | 'failed',
            timestamp: unixDate(status.timestamp),
            error: error
              ? {
                  code: String(error.code),
                  message: (error.message ?? error.title ?? 'Delivery failed').slice(0, 500),
                }
              : null,
          });
        }
      }
    }
    return events;
  }
}
