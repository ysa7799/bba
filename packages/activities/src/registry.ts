import type { Permission } from '@businessos/permissions';

/**
 * Activity type registry: the timeline's catalogue, like the event catalogue. Each type has a
 * category (for filtering), a default permission (producers may require a stricter one per row),
 * an optional channel and the metadata keys the API may expose — any other metadata stays
 * server-side. New modules add their types here.
 */
export const ACTIVITY_CATEGORIES = ['note', 'task', 'deal', 'communication', 'record'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_CHANNELS = ['phone', 'meeting', 'email', 'whatsapp', 'sms'] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];

export interface ActivityTypeDefinition {
  category: ActivityCategory;
  permission: Permission;
  channel?: ActivityChannel;
  /** Metadata keys returned by the API; everything else is internal. */
  metadataKeys: readonly string[];
  /** Logged by people (deletable by the author) rather than projected from events. */
  manual?: true;
}

export const ACTIVITY_TYPES = {
  'contact.created': {
    category: 'record',
    permission: 'crm.contact.read',
    metadataKeys: ['source'],
  },
  'contact.updated': {
    category: 'record',
    permission: 'crm.contact.read',
    metadataKeys: ['changedFields'],
  },
  'contact.tagged': { category: 'record', permission: 'crm.contact.read', metadataKeys: ['tag'] },
  'contact.untagged': { category: 'record', permission: 'crm.contact.read', metadataKeys: ['tag'] },
  'company.created': { category: 'record', permission: 'crm.company.read', metadataKeys: [] },
  'company.updated': {
    category: 'record',
    permission: 'crm.company.read',
    metadataKeys: ['changedFields'],
  },
  'deal.created': {
    category: 'deal',
    permission: 'crm.deal.read',
    metadataKeys: ['dealName', 'pipeline', 'stage', 'value'],
  },
  'deal.updated': {
    category: 'deal',
    permission: 'crm.deal.read',
    metadataKeys: ['dealName', 'changedFields'],
  },
  'deal.stage_changed': {
    category: 'deal',
    permission: 'crm.deal.read',
    metadataKeys: ['dealName', 'fromStage', 'toStage'],
  },
  'deal.won': {
    category: 'deal',
    permission: 'crm.deal.read',
    metadataKeys: ['dealName', 'value'],
  },
  'deal.lost': {
    category: 'deal',
    permission: 'crm.deal.read',
    metadataKeys: ['dealName', 'lostReason'],
  },
  'deal.deleted': { category: 'deal', permission: 'crm.deal.read', metadataKeys: ['dealName'] },
  'task.created': {
    category: 'task',
    permission: 'crm.task.read',
    metadataKeys: ['title', 'dueAt'],
  },
  'task.completed': { category: 'task', permission: 'crm.task.read', metadataKeys: ['title'] },
  'note.created': { category: 'note', permission: 'crm.contact.read', metadataKeys: ['excerpt'] },
  'call.logged': {
    category: 'communication',
    permission: 'crm.contact.read',
    channel: 'phone',
    metadataKeys: ['direction', 'durationMinutes', 'outcome', 'details'],
    manual: true,
  },
  'meeting.logged': {
    category: 'communication',
    permission: 'crm.contact.read',
    channel: 'meeting',
    metadataKeys: ['durationMinutes', 'outcome', 'details'],
    manual: true,
  },
  'email.logged': {
    category: 'communication',
    permission: 'crm.contact.read',
    channel: 'email',
    metadataKeys: ['direction', 'details'],
    manual: true,
  },
  'whatsapp.logged': {
    category: 'communication',
    permission: 'crm.contact.read',
    channel: 'whatsapp',
    metadataKeys: ['direction', 'details'],
    manual: true,
  },
  'sms.logged': {
    category: 'communication',
    permission: 'crm.contact.read',
    channel: 'sms',
    metadataKeys: ['direction', 'details'],
    manual: true,
  },
  'email.received': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'email',
    metadataKeys: ['conversationId', 'preview'],
  },
  'email.sent': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'email',
    metadataKeys: ['conversationId', 'preview'],
  },
  'whatsapp.received': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'whatsapp',
    metadataKeys: ['conversationId', 'preview'],
  },
  'whatsapp.sent': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'whatsapp',
    metadataKeys: ['conversationId', 'preview'],
  },
  'sms.received': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'sms',
    metadataKeys: ['conversationId', 'preview'],
  },
  'sms.sent': {
    category: 'communication',
    permission: 'communications.read',
    channel: 'sms',
    metadataKeys: ['conversationId', 'preview'],
  },
} as const satisfies Record<string, ActivityTypeDefinition>;

export type ActivityType = keyof typeof ACTIVITY_TYPES;

export function isActivityType(value: string): value is ActivityType {
  return Object.hasOwn(ACTIVITY_TYPES, value);
}

export function activityDefinition(type: ActivityType): ActivityTypeDefinition {
  return ACTIVITY_TYPES[type];
}

export const MANUAL_ACTIVITY_TYPES = (Object.keys(ACTIVITY_TYPES) as ActivityType[]).filter(
  (type) => (ACTIVITY_TYPES[type] as ActivityTypeDefinition).manual === true,
);
