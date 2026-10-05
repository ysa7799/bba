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
