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
