import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  canGrantRole,
  canManageMember,
  effectivePermissions,
  isPermission,
  PERMISSION_DEFINITIONS,
  systemRolePermissions,
  type Actor,
} from './index';

const owner: Actor = { permissions: new Set(ALL_PERMISSIONS), isOwner: true };
const admin: Actor = { permissions: new Set(systemRolePermissions('admin')), isOwner: false };
const restricted: Actor = {
  permissions: new Set(systemRolePermissions('restricted')),
  isOwner: false,
};

describe('catalogue', () => {
  it('uses module.resource.action style unique keys', () => {
    const keys = PERMISSION_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });

  it('rejects unknown permission strings', () => {
    expect(isPermission('settings.users.manage')).toBe(true);
    expect(isPermission('settings.users.manage ')).toBe(false);
    expect(isPermission('*')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('gives owners everything and admins everything except owner-only', () => {
    expect(systemRolePermissions('owner')).toEqual(ALL_PERMISSIONS);
    const ownerOnly = (PERMISSION_DEFINITIONS as readonly { key: string; ownerOnly?: true }[])
      .filter((definition) => definition.ownerOnly)
      .map((definition) => definition.key);
    for (const key of ownerOnly) expect(systemRolePermissions('admin')).not.toContain(key);
  });
});

describe('effective permissions', () => {
  it('derives system roles from code and ignores stored permissions for them', () => {
    const set = effectivePermissions([
      { systemKey: 'restricted', permissions: [...ALL_PERMISSIONS] },
    ]);
    expect([...set]).toEqual(systemRolePermissions('restricted'));
  });

  it('filters unknown or stale permissions on custom roles', () => {
    const set = effectivePermissions([
      { systemKey: null, permissions: ['settings.users.manage', 'superuser', 'billing.*'] },
    ]);
    expect([...set]).toEqual(['settings.users.manage']);
  });

  it('ignores unknown system keys', () => {
    expect(effectivePermissions([{ systemKey: 'god', permissions: [] }]).size).toBe(0);
  });

  it('unions multiple roles', () => {
    const set = effectivePermissions([
      { systemKey: null, permissions: ['settings.users.manage'] },
      { systemKey: null, permissions: ['settings.roles.manage'] },
    ]);
    expect(set).toEqual(new Set(['settings.users.manage', 'settings.roles.manage']));
  });
});

describe('escalation guards', () => {
  it('only owners can grant the owner role', () => {
    expect(canGrantRole(owner, { systemKey: 'owner', permissions: [] })).toBe(true);
    expect(canGrantRole(admin, { systemKey: 'owner', permissions: [] })).toBe(false);
  });

  it('cannot grant permissions the actor lacks', () => {
    const custom = { systemKey: null, permissions: ['settings.roles.manage'] };
    expect(canGrantRole(admin, custom)).toBe(true);
    expect(canGrantRole(restricted, custom)).toBe(false);
    expect(canGrantRole(restricted, { systemKey: 'admin', permissions: [] })).toBe(false);
  });

  it('cannot manage members more powerful than the actor', () => {
    expect(canManageMember(admin, [{ systemKey: 'owner', permissions: [] }])).toBe(false);
    expect(canManageMember(owner, [{ systemKey: 'owner', permissions: [] }])).toBe(true);
    expect(canManageMember(admin, [{ systemKey: 'member', permissions: [] }])).toBe(true);
    expect(canManageMember(restricted, [{ systemKey: 'admin', permissions: [] }])).toBe(false);
  });
});
