import type { Channel } from '@businessos/database';
import type { z } from 'zod';

/**
 * Provider port for messaging channels. The communications domain only sees these normalized
 * shapes; provider payloads never leave the adapter.
 */
export interface OutboundMessage {
  /** Our message id (idempotency/correlation where the provider supports it). */
  id: string;
  to: string;
  from: string;
  subject?: string | null | undefined;
  text: string;
  template?: { name: string; language: string; parameters: string[] } | null | undefined;
  /** Our thread reference (email In-Reply-To etc.). */
  replyToProviderMessageId?: string | null | undefined;
}

export interface SendResult {
  providerMessageId: string;
  status: 'sent' | 'queued';
}

export interface InboundAttachment {
  fileName: string;
  contentType: string;
  sizeBytes: number | null;
  providerMediaId: string | null;
}

export interface InboundMessageEvent {
  kind: 'message';
  providerMessageId: string;
  /** Sender address as provided (normalized later by the domain). */
  from: string;
  fromName: string | null;
  /** Our address that received it (routing double-check). */
  to: string | null;
  subject: string | null;
  text: string;
  timestamp: Date;
  attachments: InboundAttachment[];
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface StatusEvent {
  kind: 'status';
  providerMessageId: string;
  status: DeliveryStatus;
  timestamp: Date;
  error: { code: string; message: string } | null;
}

export type NormalizedEvent = InboundMessageEvent | StatusEvent;

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Public URL the provider called (some signatures cover it). */
  url: string;
  query: Record<string, string | undefined>;
}

/** A connection as an adapter sees it: decrypted credentials, never persisted in this form. */
export interface ResolvedConnection {
  id: string;
  organizationId: string;
  channel: Channel;
  address: string;
  externalAccountId: string | null;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  /** Public URL of this connection's webhook (for providers that need per-message callbacks). */
  webhookUrl: string | null;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  optional?: true;
}

export interface ChannelProvider {
  readonly key: string;
  readonly channel: Channel;
  readonly label: string;
  /** Credentials this provider needs (secret ones are write-only in the API). */
  readonly credentialFields: readonly CredentialField[];
  readonly credentialsSchema: z.ZodType<Record<string, string>>;
  /** Whether the provider needs `externalAccountId` (e.g. WhatsApp phone_number_id). */
  readonly requiresExternalAccountId: boolean;
  send(connection: ResolvedConnection, message: OutboundMessage): Promise<SendResult>;
  /** Verifies authenticity and returns normalized events; throws WebhookSignatureError. */
  parseWebhook(connection: ResolvedConnection, request: WebhookRequest): NormalizedEvent[];
  /** Subscription handshake (GET), e.g. WhatsApp `hub.challenge`. Null when not applicable. */
  verifySubscription?(
    connection: ResolvedConnection,
    query: Record<string, string | undefined>,
  ): string | null;
}

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
