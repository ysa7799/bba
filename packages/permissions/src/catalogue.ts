/**
 * Permission catalogue. Permissions are added in the phase that ships the feature they guard,
 * so a custom role can never silently gain access to a feature that did not exist when the
 * role was defined. System roles are code-defined and pick up new permissions automatically
 * according to `roles` below.
 */

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'manager', 'member', 'restricted'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface PermissionDefinition {
  key: string;
  module: string;
  label: string;
  description: string;
  /** Only owners hold it (admins do not). */
  ownerOnly?: true;
  /** System roles below admin that hold it. Owners always hold every permission; admins hold
   * every permission that is not owner-only. */
  roles: readonly Exclude<SystemRoleKey, 'owner' | 'admin'>[];
}

export const PERMISSION_DEFINITIONS = [
  {
    key: 'organization.update',
    module: 'organization',
    label: 'Edit organization',
    description: 'Change the organization profile, regional defaults and settings.',
    roles: [],
  },
  {
    key: 'settings.users.manage',
    module: 'settings',
    label: 'Manage members',
    description: 'Invite, suspend and remove members and change their roles.',
    roles: [],
  },
  {
    key: 'settings.roles.manage',
    module: 'settings',
    label: 'Manage roles',
    description: 'Create, edit and delete custom roles.',
    roles: [],
  },
  {
    key: 'settings.billing.manage',
    module: 'settings',
    label: 'Manage billing',
    description: 'View the subscription and manage the billing profile.',
    roles: [],
  },
  {
    key: 'audit.read',
    module: 'settings',
    label: 'View audit log',
    description: 'See who changed what in the organization.',
    roles: [],
  },
  {
    key: 'crm.contact.read',
    module: 'crm',
    label: 'View contacts',
    description: 'See contacts, their notes and related records.',
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'crm.contact.create',
    module: 'crm',
    label: 'Create contacts',
    description: 'Add new contacts.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.contact.update',
    module: 'crm',
    label: 'Edit contacts',
    description: 'Edit contacts, their tags and company links.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.contact.delete',
    module: 'crm',
    label: 'Delete contacts',
    description: 'Delete contacts (including in bulk).',
    roles: ['manager'],
  },
  {
    key: 'crm.company.read',
    module: 'crm',
    label: 'View companies',
    description: 'See companies and their related records.',
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'crm.company.create',
    module: 'crm',
    label: 'Create companies',
    description: 'Add new companies.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.company.update',
    module: 'crm',
    label: 'Edit companies',
    description: 'Edit companies and their tags.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.company.delete',
    module: 'crm',
    label: 'Delete companies',
    description: 'Delete companies (including in bulk).',
    roles: ['manager'],
  },
  {
    key: 'crm.deal.read',
    module: 'crm',
    label: 'View deals',
    description: 'See deals and the pipeline board.',
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'crm.deal.create',
    module: 'crm',
    label: 'Create deals',
    description: 'Add new deals.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.deal.update',
    module: 'crm',
    label: 'Edit deals',
    description: 'Edit deals and move them between stages.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.deal.delete',
    module: 'crm',
    label: 'Delete deals',
    description: 'Delete deals (including in bulk).',
    roles: ['manager'],
  },
  {
    key: 'crm.pipeline.manage',
    module: 'crm',
    label: 'Manage pipelines',
    description: 'Create, edit and delete sales pipelines and their stages.',
    roles: ['manager'],
  },
  {
    key: 'crm.task.read',
    module: 'crm',
    label: 'View tasks',
    description: 'See CRM tasks.',
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'crm.task.manage',
    module: 'crm',
    label: 'Manage tasks',
    description: 'Create, edit, assign, complete and delete CRM tasks.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.note.create',
    module: 'crm',
    label: 'Write notes',
    description: 'Add notes to records and edit or delete their own notes.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.note.manage',
    module: 'crm',
    label: 'Moderate notes',
    description: 'Edit or delete notes written by anyone.',
    roles: ['manager'],
  },
  {
    key: 'crm.activity.log',
    module: 'crm',
    label: 'Log activities',
    description: 'Log calls, meetings and messages on records and delete their own entries.',
    roles: ['manager', 'member'],
  },
  {
    key: 'crm.activity.manage',
    module: 'crm',
    label: 'Moderate activities',
    description: 'Delete activities logged by anyone.',
    roles: ['manager'],
  },
  {
    key: 'crm.tag.manage',
    module: 'crm',
    label: 'Manage tags',
    description: 'Create, rename and delete tags.',
    roles: ['manager'],
  },
  {
    key: 'crm.custom_field.manage',
    module: 'crm',
    label: 'Manage custom fields',
    description: 'Define, reorder and archive CRM custom fields.',
    roles: [],
  },
  {
    key: 'crm.data.import',
    module: 'crm',
    label: 'Import data',
    description: 'Import contacts and companies from CSV files.',
    roles: ['manager'],
  },
  {
    key: 'crm.data.export',
    module: 'crm',
    label: 'Export data',
    description: 'Export CRM records to CSV files.',
    roles: ['manager'],
  },
  {
    key: 'communications.read',
    module: 'communications',
    label: 'View conversations',
    description: 'See the shared inbox, conversations and messages.',
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'communications.send',
    module: 'communications',
    label: 'Send messages',
    description: 'Reply, start conversations and write internal notes.',
    roles: ['manager', 'member'],
  },
  {
    key: 'communications.assign',
    module: 'communications',
    label: 'Assign conversations',
    description: 'Assign, close, reopen and tag conversations.',
    roles: ['manager', 'member'],
  },
  {
    key: 'communications.manage',
    module: 'communications',
    label: 'Manage channels',
    description: 'Connect email, WhatsApp and SMS channels and manage message templates.',
    roles: [],
  },
  {
    key: 'calendar.appointment.read',
    module: 'calendar',
    label: 'View appointments',
    description: "See the organization's calendars and appointments.",
    roles: ['manager', 'member', 'restricted'],
  },
  {
    key: 'calendar.appointment.manage',
    module: 'calendar',
    label: 'Manage appointments',
    description: 'Book, reschedule and cancel appointments and set your own availability.',
    roles: ['manager', 'member'],
  },
  {
    key: 'calendar.manage',
    module: 'calendar',
    label: 'Manage scheduling',
    description:
      "Configure appointment types, booking pages, shared calendars, everyone's availability and calendar connections.",
    roles: ['manager'],
  },
] as const satisfies readonly PermissionDefinition[];

export type Permission = (typeof PERMISSION_DEFINITIONS)[number]['key'];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_DEFINITIONS.map(
  (definition) => definition.key,
);

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

export interface SystemRoleDefinition {
  key: SystemRoleKey;
  name: string;
  description: string;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { key: 'owner', name: 'Owner', description: 'Full access, including ownership-only actions.' },
  { key: 'admin', name: 'Admin', description: 'Full access except ownership-only actions.' },
  { key: 'manager', name: 'Manager', description: 'Manages team work and shared settings.' },
  { key: 'member', name: 'Member', description: 'Works with customers and records.' },
  { key: 'restricted', name: 'Restricted', description: 'Limited, mostly read-only access.' },
];

export function isSystemRoleKey(value: unknown): value is SystemRoleKey {
  return typeof value === 'string' && (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}

/** Permissions granted by a system role, derived from the catalogue. */
export function systemRolePermissions(key: SystemRoleKey): Permission[] {
  const definitions: readonly PermissionDefinition[] = PERMISSION_DEFINITIONS;
  return definitions
    .filter((definition) => {
      if (key === 'owner') return true;
      if (key === 'admin') return definition.ownerOnly !== true;
      return definition.roles.includes(key);
    })
    .map((definition) => definition.key as Permission);
}
