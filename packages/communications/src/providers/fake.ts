import type { Channel } from '@businessos/database';
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
import { hmacHex, MessagingProviderError, safeEqual } from './util';

const eventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    providerMessageId: z.string().min(1).max(200),
    from: z.string().min(1).max(320),
    fromName: z.string().max(200).nullable().default(null),
    to: z.string().max(320).nullable().default(null),
    subject: z.string().max(500).nullable().default(null),
    text: z.string().max(65_536),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    attachments: z
      .array(
        z.object({
          fileName: z.string().min(1).max(255),
          contentType: z.string().max(200),
          sizeBytes: z.number().int().nonnegative().nullable().default(null),
          providerMediaId: z.string().max(200).nullable().default(null),
        }),
      )
      .max(20)
      .default([]),
  }),
  z.object({
    kind: z.literal('status'),
    providerMessageId: z.string().min(1).max(200),
    status: z.enum(['sent', 'delivered', 'read', 'failed']),
    timestamp: z.iso.datetime({ offset: true }).optional(),
    error: z
      .object({ code: z.string().max(100), message: z.string().max(500) })
      .nullable()
      .default(null),
  }),
]);
const payloadSchema = z.object({ events: z.array(eventSchema).max(100) });
export type FakeWebhookPayload = z.input<typeof payloadSchema>;

/**
 * Development/test provider for any channel. Sends are recorded in memory; webhooks are signed
 * with the connection's `webhookSecret` (`x-fake-signature: sha256 hex of the raw body`).
 * Refused in production by the API configuration.
 */
export class FakeChannelProvider implements ChannelProvider {
  readonly key: string;
  readonly label: string;
  readonly credentialFields = [
    { key: 'webhookSecret', label: 'Webhook secret', secret: true, optional: true },
  ] as const;
  readonly credentialsSchema = z.object({ webhookSecret: z.string().min(16).max(200) });
  readonly requiresExternalAccountId = false;
  readonly sent: (OutboundMessage & { connectionId: string })[] = [];
  private failures: { code: string; retryable: boolean }[] = [];

  constructor(readonly channel: Channel) {
    this.key = `fake_${channel}`;
    this.label = `Test ${channel} (development)`;
  }

  /** Makes the next `send` calls fail (tests). */
  failNext(code: string, retryable: boolean): void {
    this.failures.push({ code, retryable });
  }

  send(connection: ResolvedConnection, message: OutboundMessage): Promise<SendResult> {
    const failure = this.failures.shift();
    if (failure) {
      return Promise.reject(
        new MessagingProviderError(this.key, 'Simulated provider failure', {
          retryable: failure.retryable,
          providerCode: failure.code,
        }),
      );
    }
    this.sent.push({ ...message, connectionId: connection.id });
    return Promise.resolve({ providerMessageId: `fake_${message.id}`, status: 'sent' });
  }

  static sign(rawBody: string | Buffer, secret: string): string {
    return hmacHex('sha256', secret, rawBody);
  }

  parseWebhook(connection: ResolvedConnection, request: WebhookRequest): NormalizedEvent[] {
    const secret = connection.credentials.webhookSecret;
    const signature = header(request.headers, 'x-fake-signature');
    if (
      !secret ||
      !signature ||
      !safeEqual(signature, FakeChannelProvider.sign(request.rawBody, secret))
    ) {
      throw new WebhookSignatureError();
    }
    let parsed: z.infer<typeof payloadSchema>;
    try {
      parsed = payloadSchema.parse(JSON.parse(request.rawBody.toString('utf8')));
    } catch {
      throw new WebhookSignatureError('Malformed webhook payload');
    }
    return parsed.events.map((event) =>
      event.kind === 'message'
        ? { ...event, timestamp: event.timestamp ? new Date(event.timestamp) : new Date() }
        : { ...event, timestamp: event.timestamp ? new Date(event.timestamp) : new Date() },
    );
  }
}
