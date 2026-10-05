import type { EventType } from '@businessos/events';
import type { Permission } from '@businessos/permissions';

export interface NotificationTypeDefinition {
  /** The domain event that produces it. */
  event: EventType;
  /** A member receives it only while they hold this permission. */
  permission: Permission;
  /** Default channels (each member can change them). */
  defaults: { inApp: boolean; email: boolean };
}

/** What members can be notified about. Each type has exactly one source event. */
export const NOTIFICATION_TYPES = {
  'task.assigned': {
    event: 'task.created',
    permission: 'crm.task.read',
    defaults: { inApp: true, email: true },
  },
  'conversation.assigned': {
    event: 'conversation.assigned',
    permission: 'communications.read',
    defaults: { inApp: true, email: true },
  },
  'deal.won': {
    event: 'deal.won',
    permission: 'crm.deal.read',
    defaults: { inApp: true, email: false },
  },
  'appointment.booked': {
    event: 'appointment.booked',
    permission: 'calendar.appointment.read',
    defaults: { inApp: true, email: true },
  },
  'quote.accepted': {
    event: 'quote.accepted',
    permission: 'commerce.invoice.read',
    defaults: { inApp: true, email: true },
  },
  'quote.declined': {
    event: 'quote.declined',
    permission: 'commerce.invoice.read',
    defaults: { inApp: true, email: false },
  },
  'invoice.paid': {
    event: 'invoice.paid',
    permission: 'commerce.invoice.read',
    defaults: { inApp: true, email: true },
  },
  'invoice.overdue': {
    event: 'invoice.overdue',
    permission: 'commerce.invoice.read',
    defaults: { inApp: true, email: false },
  },
  'workflow.failed': {
    event: 'workflow.failed',
    permission: 'automation.workflow.read',
    defaults: { inApp: true, email: true },
  },
} as const satisfies Record<string, NotificationTypeDefinition>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_KEYS = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && Object.hasOwn(NOTIFICATION_TYPES, value);
}

export const NOTIFICATION_EVENTS = [
  ...new Set(NOTIFICATION_TYPE_KEYS.map((type) => NOTIFICATION_TYPES[type].event)),
] as EventType[];
