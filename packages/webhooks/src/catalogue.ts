import type { DomainEvent, EventType } from '@businessos/events';

/**
 * Events customers can subscribe to. Platform-internal events (organization, membership,
 * subscription billing, platform payments, workflow internals) are not part of the contract.
 * Payloads carry ids and small facts only (never contact details or message text), so a
 * receiver fetches anything else through the API with its own key and scopes.
 */
export const WEBHOOK_EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'contact.tag_added',
  'contact.tag_removed',
  'company.created',
  'company.updated',
  'company.deleted',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'deal.deleted',
  'task.created',
  'task.completed',
  'note.created',
  'conversation.created',
  'conversation.assigned',
  'conversation.status_changed',
  'message.received',
  'message.sent',
  'message.failed',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.status_changed',
  'form.submitted',
  'quote.sent',
  'quote.accepted',
  'quote.declined',
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
] as const satisfies readonly EventType[];
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Sent by "Send test event"; never produced by the domain. */
export const TEST_EVENT_TYPE = 'webhook.test';

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** The JSON body customers receive (versioned per event type). */
export interface WebhookEnvelope {
  id: string;
  type: string;
  version: number;
  createdAt: string;
  organizationId: string;
  subject: { type: string; id: string };
  data: unknown;
}

export function envelopeFor(event: DomainEvent, organizationId: string): WebhookEnvelope {
  return {
    id: event.id,
    type: event.type,
    version: event.version,
    createdAt: event.occurredAt.toISOString(),
    organizationId,
    subject: event.subject,
    data: event.payload,
  };
}
