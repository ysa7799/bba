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
  hmacBase64,
  isRetryableStatus,
  MessagingProviderError,
  providerFetch,
  requireCredential,
  safeEqual,
} from './util';

/** Twilio's request signature: base64 HMAC-SHA1 over the URL plus sorted form parameters. */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return hmacBase64('sha1', authToken, data);
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed' | undefined> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  undelivered: 'failed',
  failed: 'failed',
};

/**
 * Twilio Programmable Messaging (SMS). The sending address is an E.164 number, an alphanumeric
 * sender id or a Messaging Service SID (`MG…`). Webhooks are verified with `X-Twilio-Signature`
 * against the exact public URL Twilio called.
 */
export class TwilioSmsProvider implements ChannelProvider {
  readonly key = 'twilio';
  readonly channel = 'sms' as const;
  readonly label = 'Twilio SMS';
  readonly credentialFields = [
    { key: 'accountSid', label: 'Account SID', secret: false },
    { key: 'authToken', label: 'Auth token', secret: true },
  ] as const;
  readonly credentialsSchema = z.object({
    accountSid: z
      .string()
      .regex(/^AC[0-9a-f]{32}$/, { message: 'Starts with AC followed by 32 hex characters' }),
    authToken: z.string().min(16).max(200),
  });
  readonly requiresExternalAccountId = false;

  constructor(private readonly options: { fetch?: typeof fetch; baseUrl?: string } = {}) {}

  async send(connection: ResolvedConnection, message: OutboundMessage): Promise<SendResult> {
    const accountSid = requireCredential(connection.credentials, 'accountSid', this.key);
    const authToken = requireCredential(connection.credentials, 'authToken', this.key);
    const form = new URLSearchParams({ To: message.to, Body: message.text });
    if (connection.address.startsWith('MG')) form.set('MessagingServiceSid', connection.address);
    else form.set('From', connection.address);
    if (connection.webhookUrl) form.set('StatusCallback', connection.webhookUrl);
    const response = await providerFetch(
      this.key,
      this.options.fetch ?? fetch,
      `${this.options.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    const body = (response.body ?? {}) as { sid?: unknown; code?: unknown };
    if (!response.ok || typeof body.sid !== 'string') {
      throw new MessagingProviderError(
        this.key,
        `Twilio rejected the message (HTTP ${response.status})`,
        {
          retryable: isRetryableStatus(response.status),
          providerCode: typeof body.code === 'number' ? String(body.code) : null,
        },
      );
    }
    return { providerMessageId: body.sid, status: 'queued' };
  }

  parseWebhook(connection: ResolvedConnection, request: WebhookRequest): NormalizedEvent[] {
    const authToken = connection.credentials.authToken;
    const params = Object.fromEntries(new URLSearchParams(request.rawBody.toString('utf8')));
    const signature = header(request.headers, 'x-twilio-signature') ?? '';
    if (!authToken || !safeEqual(signature, twilioSignature(authToken, request.url, params))) {
      throw new WebhookSignatureError();
    }
    const sid = params.MessageSid ?? params.SmsSid;
    if (!sid) return [];
    const status = params.MessageStatus ?? params.SmsStatus;
    if (status && status !== 'received') {
      const mapped = STATUS_MAP[status];
      if (!mapped) return [];
      return [
        {
          kind: 'status',
          providerMessageId: sid,
          status: mapped,
          timestamp: new Date(),
          error: params.ErrorCode
            ? { code: params.ErrorCode, message: `Twilio error ${params.ErrorCode}` }
            : null,
        },
      ];
    }
    const media = Number(params.NumMedia ?? '0');
    const attachments = Array.from(
      { length: Number.isInteger(media) ? Math.min(media, 10) : 0 },
      (_, index) => ({
        fileName: `media-${index + 1}`,
        contentType: params[`MediaContentType${index}`] ?? 'application/octet-stream',
        sizeBytes: null,
        providerMediaId: params[`MediaUrl${index}`] ?? null,
      }),
    );
    return [
      {
        kind: 'message',
        providerMessageId: sid,
        from: params.From ?? '',
        fromName: null,
        to: params.To ?? null,
        subject: null,
        text: (params.Body ?? '').slice(0, 65_536),
        timestamp: new Date(),
        attachments,
      },
    ];
  }
}
