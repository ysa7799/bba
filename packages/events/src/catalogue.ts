import { z } from 'zod';

/**
 * Domain event catalogue. Each event type has a version and a payload schema; payloads are
 * validated when emitted and again when delivered. Breaking payload changes bump `version`.
 * Payloads carry identifiers and small facts, not whole records or secrets.
 */
export const EVENT_DEFINITIONS = {
  'organization.created': {
    version: 1,
    schema: z.object({ name: z.string(), createdByUserId: z.uuid().nullable() }),
  },
  'organization.updated': {
    version: 1,
    schema: z.object({ changedFields: z.array(z.string()) }),
  },
  'member.invited': {
    version: 1,
    schema: z.object({ invitationId: z.uuid(), roleId: z.uuid() }),
  },
  'member.joined': {
    version: 1,
    schema: z.object({
      membershipId: z.uuid(),
      userId: z.uuid(),
      via: z.enum(['organization_created', 'invitation']),
    }),
  },
  'member.roles_changed': {
    version: 1,
    schema: z.object({
      membershipId: z.uuid(),
      addedRoleIds: z.array(z.uuid()),
      removedRoleIds: z.array(z.uuid()),
    }),
  },
  'subscription.started': {
    version: 1,
    schema: z.object({ subscriptionId: z.uuid(), planVersionId: z.uuid() }),
  },
  'subscription.changed': {
    version: 1,
    schema: z.object({
      subscriptionId: z.uuid(),
      fromPlanVersionId: z.uuid(),
      toPlanVersionId: z.uuid(),
      status: z.string(),
    }),
  },
  'subscription.canceled': {
    version: 1,
    schema: z.object({ subscriptionId: z.uuid() }),
  },
  'payment.succeeded': {
    version: 1,
    schema: z.object({
      paymentId: z.uuid(),
      purpose: z.enum(['subscription', 'invoice']),
      amountMinor: z.string().regex(/^\d+$/),
      currency: z.string().length(3),
    }),
  },
  'payment.failed': {
    version: 1,
    schema: z.object({
      paymentId: z.uuid(),
      purpose: z.enum(['subscription', 'invoice']),
      failureCode: z.string().nullable(),
    }),
  },
  'payment.refunded': {
    version: 1,
    schema: z.object({
      paymentId: z.uuid(),
      refundedMinor: z.string().regex(/^\d+$/),
      currency: z.string().length(3),
    }),
  },
  'member.removed': {
    version: 1,
    schema: z.object({
      membershipId: z.uuid(),
      userId: z.uuid(),
      reason: z.enum(['removed', 'left']),
    }),
  },
  'contact.created': {
    version: 1,
    schema: z.object({ contactId: z.uuid(), source: z.string() }),
  },
  'contact.updated': {
    version: 1,
    schema: z.object({ contactId: z.uuid(), changedFields: z.array(z.string()) }),
  },
  'contact.deleted': {
    version: 1,
    schema: z.object({ contactId: z.uuid() }),
  },
  'contact.tag_added': {
    version: 1,
    schema: z.object({ contactId: z.uuid(), tagId: z.uuid() }),
  },
  'contact.tag_removed': {
    version: 1,
    schema: z.object({ contactId: z.uuid(), tagId: z.uuid() }),
  },
  'company.created': {
    version: 1,
    schema: z.object({ companyId: z.uuid() }),
  },
  'company.updated': {
    version: 1,
    schema: z.object({ companyId: z.uuid(), changedFields: z.array(z.string()) }),
  },
  'company.deleted': {
    version: 1,
    schema: z.object({ companyId: z.uuid() }),
  },
  'deal.created': {
    version: 1,
    schema: z.object({ dealId: z.uuid(), pipelineId: z.uuid(), stageId: z.uuid() }),
  },
  'deal.updated': {
    version: 1,
    schema: z.object({ dealId: z.uuid(), changedFields: z.array(z.string()) }),
  },
  'deal.stage_changed': {
    version: 1,
    schema: z.object({
      dealId: z.uuid(),
      pipelineId: z.uuid(),
      fromStageId: z.uuid(),
      toStageId: z.uuid(),
    }),
  },
  'deal.won': {
    version: 1,
    schema: z.object({
      dealId: z.uuid(),
      valueMinor: z.string().regex(/^\d+$/).nullable(),
      currency: z.string().length(3),
    }),
  },
  'deal.lost': {
    version: 1,
    schema: z.object({ dealId: z.uuid(), lostReason: z.string().nullable() }),
  },
  'deal.deleted': {
    version: 1,
    schema: z.object({ dealId: z.uuid() }),
  },
  'task.created': {
    version: 1,
    schema: z.object({ taskId: z.uuid(), assigneeUserId: z.uuid().nullable() }),
  },
  'task.completed': {
    version: 1,
    schema: z.object({ taskId: z.uuid(), completedByUserId: z.uuid().nullable() }),
  },
  'note.created': {
    version: 1,
    schema: z.object({
      noteId: z.uuid(),
      parentType: z.enum(['contact', 'company', 'deal']),
      parentId: z.uuid(),
    }),
  },
  'conversation.created': {
    version: 1,
    schema: z.object({
      conversationId: z.uuid(),
      channel: z.enum(['email', 'whatsapp', 'sms']),
      contactId: z.uuid().nullable(),
    }),
  },
  'conversation.assigned': {
    version: 1,
    schema: z.object({ conversationId: z.uuid(), assigneeUserId: z.uuid().nullable() }),
  },
  'conversation.status_changed': {
    version: 1,
    schema: z.object({ conversationId: z.uuid(), status: z.enum(['open', 'closed']) }),
  },
  'message.received': {
    version: 1,
    schema: z.object({
      messageId: z.uuid(),
      conversationId: z.uuid(),
      channel: z.enum(['email', 'whatsapp', 'sms']),
      contactId: z.uuid().nullable(),
    }),
  },
  'message.sent': {
    version: 1,
    schema: z.object({
      messageId: z.uuid(),
      conversationId: z.uuid(),
      channel: z.enum(['email', 'whatsapp', 'sms']),
      contactId: z.uuid().nullable(),
    }),
  },
  'message.failed': {
    version: 1,
    schema: z.object({
      messageId: z.uuid(),
      conversationId: z.uuid(),
      errorCode: z.string().max(100).nullable(),
    }),
  },
  'activity.logged': {
    version: 1,
    schema: z.object({ activityId: z.uuid(), type: z.string().max(60) }),
  },
  'appointment.booked': {
    version: 1,
    schema: z.object({
      appointmentId: z.uuid(),
      appointmentTypeId: z.uuid().nullable(),
      calendarIds: z.array(z.uuid()).min(1),
      contactId: z.uuid().nullable(),
      startsAt: z.iso.datetime(),
      source: z.enum(['booking_page', 'staff']),
    }),
  },
  'appointment.rescheduled': {
    version: 1,
    schema: z.object({
      appointmentId: z.uuid(),
      contactId: z.uuid().nullable(),
      startsAt: z.iso.datetime(),
      previousStartsAt: z.iso.datetime(),
      by: z.enum(['invitee', 'staff']),
    }),
  },
  'appointment.cancelled': {
    version: 1,
    schema: z.object({
      appointmentId: z.uuid(),
      contactId: z.uuid().nullable(),
      startsAt: z.iso.datetime(),
      by: z.enum(['invitee', 'staff']),
    }),
  },
  'appointment.status_changed': {
    version: 1,
    schema: z.object({
      appointmentId: z.uuid(),
      contactId: z.uuid().nullable(),
      from: z.enum(['scheduled', 'cancelled', 'completed', 'no_show']),
      to: z.enum(['scheduled', 'cancelled', 'completed', 'no_show']),
    }),
  },
  'quote.sent': {
    version: 1,
    schema: z.object({ quoteId: z.uuid(), contactId: z.uuid() }),
  },
  'quote.accepted': {
    version: 1,
    schema: z.object({ quoteId: z.uuid(), contactId: z.uuid(), by: z.enum(['customer', 'staff']) }),
  },
  'quote.declined': {
    version: 1,
    schema: z.object({ quoteId: z.uuid(), contactId: z.uuid(), by: z.enum(['customer', 'staff']) }),
  },
  'invoice.created': {
    version: 1,
    schema: z.object({
      invoiceId: z.uuid(),
      contactId: z.uuid(),
      dealId: z.uuid().nullable(),
      quoteId: z.uuid().nullable(),
    }),
  },
  'invoice.sent': {
    version: 1,
    schema: z.object({
      invoiceId: z.uuid(),
      contactId: z.uuid(),
      totalMinor: z.string().regex(/^\d+$/),
      currency: z.string().length(3),
    }),
  },
  'invoice.paid': {
    version: 1,
    schema: z.object({
      invoiceId: z.uuid(),
      contactId: z.uuid(),
      totalMinor: z.string().regex(/^\d+$/),
      currency: z.string().length(3),
    }),
  },
  'invoice.overdue': {
    version: 1,
    schema: z.object({ invoiceId: z.uuid(), contactId: z.uuid(), dueDate: z.iso.date() }),
  },
  'invoice.voided': {
    version: 1,
    schema: z.object({ invoiceId: z.uuid(), contactId: z.uuid() }),
  },
  'workflow.started': {
    version: 1,
    schema: z.object({
      workflowId: z.uuid(),
      versionId: z.uuid(),
      runId: z.uuid(),
      triggerType: z.string().max(60),
    }),
  },
  'workflow.completed': {
    version: 1,
    schema: z.object({ workflowId: z.uuid(), runId: z.uuid() }),
  },
  'workflow.failed': {
    version: 1,
    schema: z.object({ workflowId: z.uuid(), runId: z.uuid(), error: z.string().max(500) }),
  },
  'form.submitted': {
    version: 1,
    schema: z.object({
      formId: z.uuid(),
      versionId: z.uuid(),
      submissionId: z.uuid(),
      contactId: z.uuid().nullable(),
      dealId: z.uuid().nullable(),
    }),
  },
} as const satisfies Record<string, { version: number; schema: z.ZodType }>;

export type EventType = keyof typeof EVENT_DEFINITIONS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_DEFINITIONS)[T]['schema']>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_DEFINITIONS, value);
}

export const EVENT_ACTOR_TYPES = ['user', 'api_key', 'system', 'workflow'] as const;
export type EventActorType = (typeof EVENT_ACTOR_TYPES)[number];

export interface EventActor {
  type: EventActorType;
  id: string | null;
}

/** Envelope handed to subscribers (see docs/EVENTS.md). */
export interface DomainEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  version: number;
  organizationId: string | null;
  occurredAt: Date;
  actor: EventActor;
  subject: { type: string; id: string };
  correlationId: string | null;
  causationId: string | null;
  payload: EventPayload<T>;
}
