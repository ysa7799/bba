import { tokenFromLink } from '@businessos/auth';
import { membershipRoles, roles, withSystem } from '@businessos/database';
import { systemRolePermissions } from '@businessos/permissions';
import { newId } from '@businessos/shared';
import {
  actorFor,
  addTestMember,
  createTestUser,
  createTestWorld,
  systemRoleId,
  type TestWorld,
} from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, TestClient, TEST_PASSWORD, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

async function membershipOf(orgId: string, userId: string): Promise<string> {
  return (await actorFor(ctx.db.db, orgId, userId)).membershipId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

describe('permission enforcement', () => {
  it('exposes the caller’s effective access', async () => {
    const owner = await (await as(world.orgA.users.owner)).get(`/app/orgs/${A}/access`);
    expect(owner.json()).toMatchObject({ isOwner: true });
    expect(owner.json().permissions).toEqual(
      expect.arrayContaining(['organization.update', 'settings.roles.manage']),
    );
    const restricted = await (await as(world.orgA.users.restricted)).get(`/app/orgs/${A}/access`);
    expect(restricted.json()).toMatchObject({ isOwner: false });
    expect([...restricted.json().permissions].sort()).toEqual(
      [...systemRolePermissions('restricted')].sort(),
    );
    expect(restricted.json().permissions).not.toContain('crm.contact.create');
  });

  const guarded: [
    string,
    'PATCH' | 'POST' | 'PUT' | 'DELETE' | 'GET',
    (ids: { member: string }) => string,
    unknown,
  ][] = [
    ['update organization', 'PATCH', () => `/app/orgs/${A}`, { name: 'Renamed' }],
    ['update settings', 'PATCH', () => `/app/orgs/${A}/settings`, { 'general.week_start_day': 1 }],
    ['list invitations', 'GET', () => `/app/orgs/${A}/invitations`, undefined],
    [
      'invite',
      'POST',
      () => `/app/orgs/${A}/invitations`,
      { email: 'x@example.com', roleId: newId() },
    ],
    [
      'change roles',
      'PUT',
      ({ member }) => `/app/orgs/${A}/members/${member}/roles`,
      { roleIds: [newId()] },
    ],
    [
      'suspend member',
      'PATCH',
      ({ member }) => `/app/orgs/${A}/members/${member}`,
      { status: 'suspended' },
    ],
    ['remove member', 'DELETE', ({ member }) => `/app/orgs/${A}/members/${member}`, undefined],
    ['create role', 'POST', () => `/app/orgs/${A}/roles`, { name: 'X', permissions: [] }],
  ];

  it.each(guarded)(
    'members without permission cannot %s (403)',
    async (_name, method, url, body) => {
      const member = await membershipOf(A, world.orgA.users.admin.id);
      for (const user of [
        world.orgA.users.restricted,
        world.orgA.users.sales,
        world.orgA.users.manager,
      ]) {
        const response = await (await as(user)).request(method, url({ member }), body);
        expect(response.statusCode, `${user.name} ${method}`).toBe(403);
      }
    },
  );

  it.each(guarded)(
    'non-members cannot %s and learn nothing (404)',
    async (_name, method, url, body) => {
      const member = await membershipOf(A, world.orgA.users.admin.id);
      const response = await (
        await as(world.orgB.users.owner)
      ).request(method, url({ member }), body);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    },
  );

  it('allows admins to update the organization and ignores privileged fields', async () => {
    const response = await (
      await as(world.orgA.users.admin)
    ).patch(`/app/orgs/${A}`, {
      timezone: 'Asia/Riyadh',
      status: 'suspended',
      slug: 'hijacked',
      id: B,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().organization).toMatchObject({
      id: A,
      timezone: 'Asia/Riyadh',
      status: 'active',
      slug: world.orgA.organization.slug,
    });
  });
});

describe('privilege escalation', () => {
  it('admins cannot grant the owner role (to themselves or others)', async () => {
    const admin = await as(world.orgA.users.admin);
    const ownerRole = await systemRoleId(ctx.db.db, A, 'owner');
    for (const userId of [world.orgA.users.admin.id, world.orgA.users.sales.id]) {
      const membership = await membershipOf(A, userId);
      const response = await admin.request('PUT', `/app/orgs/${A}/members/${membership}/roles`, {
        roleIds: [ownerRole],
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('admins cannot demote, suspend or remove owners', async () => {
    const admin = await as(world.orgA.users.admin);
    const ownerMembership = await membershipOf(A, world.orgA.users.owner.id);
    const memberRole = await systemRoleId(ctx.db.db, A, 'member');
    expect(
      (
        await admin.request('PUT', `/app/orgs/${A}/members/${ownerMembership}/roles`, {
          roleIds: [memberRole],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await admin.patch(`/app/orgs/${A}/members/${ownerMembership}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(403);
    expect((await admin.delete(`/app/orgs/${A}/members/${ownerMembership}`)).statusCode).toBe(403);
  });

  it('a delegated member manager cannot grant more than they hold', async () => {
    // A custom role that can manage members but nothing else.
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(`/app/orgs/${A}/roles`, {
      name: 'People ops',
      permissions: ['settings.users.manage'],
    });
    expect(created.statusCode).toBe(201);
    const peopleOps = created.json().role.id as string;

    const delegate = await createTestUser(ctx.db.db, { name: 'Delegate' });
    const delegateMembership = await addTestMember(ctx.db.db, A, delegate.id, {
      role: 'restricted',
    });
    await owner.request('PUT', `/app/orgs/${A}/members/${delegateMembership}/roles`, {
      roleIds: [peopleOps],
    });
    const client = await as(delegate);

    const target = await membershipOf(A, world.orgA.users.restricted.id);
    const adminRole = await systemRoleId(ctx.db.db, A, 'admin');
    const memberRole = await systemRoleId(ctx.db.db, A, 'member');
    // Granting admin (which includes permissions the delegate lacks) is escalation.
    expect(
      (
        await client.request('PUT', `/app/orgs/${A}/members/${target}/roles`, {
          roleIds: [adminRole],
        })
      ).statusCode,
    ).toBe(403);
    // Granting the delegate's own role to themselves is a no-op change and allowed; granting
    // themselves admin is not.
    expect(
      (
        await client.request('PUT', `/app/orgs/${A}/members/${delegateMembership}/roles`, {
          roleIds: [peopleOps, adminRole],
        })
      ).statusCode,
    ).toBe(403);
    // Defining a role with permissions they lack is escalation too.
    expect(
      (
        await client.post(`/app/orgs/${A}/roles`, {
          name: 'Sneaky',
          permissions: ['settings.roles.manage'],
        })
      ).statusCode,
    ).toBe(403);
    // Inviting someone as admin is escalation, and so is the member role (it grants CRM
    // permissions the delegate lacks); inviting with a role within their own access is fine.
    expect(
      (
        await client.post(`/app/orgs/${A}/invitations`, {
          email: 'admin-invite@example.com',
          roleId: adminRole,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.post(`/app/orgs/${A}/invitations`, {
          email: 'member-invite@example.com',
          roleId: memberRole,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await client.post(`/app/orgs/${A}/invitations`, {
          email: 'peer-invite@example.com',
          roleId: peopleOps,
        })
      ).statusCode,
    ).toBe(201);
    // Managing someone more powerful (an admin) is refused.
    const adminMembership = await membershipOf(A, world.orgA.users.admin.id);
    expect(
      (await client.patch(`/app/orgs/${A}/members/${adminMembership}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(403);
  });

  it('cannot edit or delete system roles', async () => {
    const owner = await as(world.orgA.users.owner);
    const adminRole = await systemRoleId(ctx.db.db, A, 'admin');
    expect(
      (await owner.patch(`/app/orgs/${A}/roles/${adminRole}`, { name: 'Boss' })).statusCode,
    ).toBe(403);
    expect((await owner.delete(`/app/orgs/${A}/roles/${adminRole}`)).statusCode).toBe(403);
  });

  it('rejects unknown permissions in custom roles', async () => {
    const owner = await as(world.orgA.users.owner);
    const response = await owner.post(`/app/orgs/${A}/roles`, {
      name: 'Wildcard',
      permissions: ['*', 'platform.admin'],
    });
    expect(response.statusCode).toBe(400);
  });

  it('role changes take effect on the very next request', async () => {
    const user = await createTestUser(ctx.db.db, { name: 'Promoted' });
    const membership = await addTestMember(ctx.db.db, A, user.id, { role: 'restricted' });
    const client = await as(user);
    expect((await client.patch(`/app/orgs/${A}`, { locale: 'ar' })).statusCode).toBe(403);
    const owner = await as(world.orgA.users.owner);
    const adminRole = await systemRoleId(ctx.db.db, A, 'admin');
    expect(
      (
        await owner.request('PUT', `/app/orgs/${A}/members/${membership}/roles`, {
          roleIds: [adminRole],
        })
      ).statusCode,
    ).toBe(200);
    expect((await client.patch(`/app/orgs/${A}`, { locale: 'ar' })).statusCode).toBe(200);
    const restrictedRole = await systemRoleId(ctx.db.db, A, 'restricted');
    await owner.request('PUT', `/app/orgs/${A}/members/${membership}/roles`, {
      roleIds: [restrictedRole],
    });
    expect((await client.patch(`/app/orgs/${A}`, { locale: 'en' })).statusCode).toBe(403);
  });
});

describe('cross-tenant references', () => {
  it('cannot assign a role belonging to another organization', async () => {
    const owner = await as(world.orgA.users.owner);
    const foreignRole = await systemRoleId(ctx.db.db, B, 'member');
    const target = await membershipOf(A, world.orgA.users.sales.id);
    const response = await owner.request('PUT', `/app/orgs/${A}/members/${target}/roles`, {
      roleIds: [foreignRole],
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot manage members of another organization via its membership id', async () => {
    const owner = await as(world.orgA.users.owner);
    const foreignMember = await membershipOf(B, world.orgB.users.admin.id);
    const memberRole = await systemRoleId(ctx.db.db, A, 'member');
    expect(
      (
        await owner.request('PUT', `/app/orgs/${A}/members/${foreignMember}/roles`, {
          roleIds: [memberRole],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await owner.patch(`/app/orgs/${A}/members/${foreignMember}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(404);
    expect((await owner.delete(`/app/orgs/${A}/members/${foreignMember}`)).statusCode).toBe(404);
    // Still a member of B.
    expect((await (await as(world.orgB.users.admin)).get(`/app/orgs/${B}`)).statusCode).toBe(200);
  });

  it('cannot invite with, edit or delete another organization’s roles', async () => {
    const owner = await as(world.orgA.users.owner);
    const foreignRole = await systemRoleId(ctx.db.db, B, 'member');
    expect(
      (
        await owner.post(`/app/orgs/${A}/invitations`, {
          email: 'cross@example.com',
          roleId: foreignRole,
        })
      ).statusCode,
    ).toBe(404);
    const bOwner = await as(world.orgB.users.owner);
    const custom = await bOwner.post(`/app/orgs/${B}/roles`, { name: 'B custom', permissions: [] });
    const bRole = custom.json().role.id as string;
    expect((await owner.patch(`/app/orgs/${A}/roles/${bRole}`, { name: 'pwned' })).statusCode).toBe(
      404,
    );
    expect((await owner.delete(`/app/orgs/${A}/roles/${bRole}`)).statusCode).toBe(404);
  });

  it('the database itself rejects cross-tenant role assignments', async () => {
    const foreignRole = await systemRoleId(ctx.db.db, B, 'admin');
    const membership = await membershipOf(A, world.orgA.users.sales.id);
    await expect(
      withSystem(ctx.db.db, (tx) =>
        tx
          .insert(membershipRoles)
          .values({ organizationId: A, membershipId: membership, roleId: foreignRole }),
      ),
    ).rejects.toThrow();
  });

  it('lists only this organization’s roles', async () => {
    const response = await (await as(world.orgA.users.sales)).get(`/app/orgs/${A}/roles`);
    const ids = (response.json().data as { id: string }[]).map((role) => role.id);
    const foreign = await withSystem(ctx.db.db, (tx) =>
      tx.select({ id: roles.id }).from(roles).where(eq(roles.organizationId, B)),
    );
    for (const role of foreign) expect(ids).not.toContain(role.id);
  });
});

describe('ownership invariants', () => {
  async function freshOrg() {
    const ownerUser = await createTestUser(ctx.db.db, { name: 'Solo owner' });
    const owner = await as(ownerUser);
    const created = await owner.post('/app/orgs', { name: 'Invariant Co' });
    const orgId = created.json().organization.id as string;
    return { owner, ownerUser, orgId, ownerMembership: await membershipOf(orgId, ownerUser.id) };
  }

  it('the last owner cannot be demoted, suspend themselves or leave', async () => {
    const { owner, orgId, ownerMembership } = await freshOrg();
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const demote = await owner.request(
      'PUT',
      `/app/orgs/${orgId}/members/${ownerMembership}/roles`,
      {
        roleIds: [memberRole],
      },
    );
    expect(demote.statusCode).toBe(409);
    expect(
      (await owner.patch(`/app/orgs/${orgId}/members/${ownerMembership}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(403);
    expect((await owner.post(`/app/orgs/${orgId}/leave`)).statusCode).toBe(409);
  });

  it('ownership can be transferred, then the previous owner can step down', async () => {
    const { owner, orgId, ownerMembership } = await freshOrg();
    const successor = await createTestUser(ctx.db.db, { name: 'Successor' });
    const successorMembership = await addTestMember(ctx.db.db, orgId, successor.id, {
      role: 'admin',
    });
    const ownerRole = await systemRoleId(ctx.db.db, orgId, 'owner');
    const adminRole = await systemRoleId(ctx.db.db, orgId, 'admin');
    expect(
      (
        await owner.request('PUT', `/app/orgs/${orgId}/members/${successorMembership}/roles`, {
          roleIds: [ownerRole],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await owner.request('PUT', `/app/orgs/${orgId}/members/${ownerMembership}/roles`, {
          roleIds: [adminRole],
        })
      ).statusCode,
    ).toBe(200);
    const access = await owner.get(`/app/orgs/${orgId}/access`);
    expect(access.json().isOwner).toBe(false);
  });

  it('concurrent demotions never leave an organization without an owner', async () => {
    const { owner, orgId, ownerMembership } = await freshOrg();
    const second = await createTestUser(ctx.db.db, { name: 'Co-owner' });
    const secondMembership = await addTestMember(ctx.db.db, orgId, second.id, { role: 'owner' });
    const secondClient = await as(second);
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const results = await Promise.all([
      owner.request('PUT', `/app/orgs/${orgId}/members/${secondMembership}/roles`, {
        roleIds: [memberRole],
      }),
      secondClient.request('PUT', `/app/orgs/${orgId}/members/${ownerMembership}/roles`, {
        roleIds: [memberRole],
      }),
    ]);
    const statuses = results.map((response) => response.statusCode).sort();
    expect(statuses).toContain(200);
    const ownerRole = await systemRoleId(ctx.db.db, orgId, 'owner');
    const owners = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(membershipRoles)
        .where(
          and(eq(membershipRoles.organizationId, orgId), eq(membershipRoles.roleId, ownerRole)),
        ),
    );
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });
});

describe('member lifecycle', () => {
  it('removal and suspension revoke access immediately', async () => {
    const user = await createTestUser(ctx.db.db, { name: 'Leaver' });
    const membership = await addTestMember(ctx.db.db, A, user.id);
    const client = await as(user);
    expect((await client.get(`/app/orgs/${A}`)).statusCode).toBe(200);
    const admin = await as(world.orgA.users.admin);
    expect(
      (await admin.patch(`/app/orgs/${A}/members/${membership}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(204);
    expect((await client.get(`/app/orgs/${A}`)).statusCode).toBe(404);
    expect(
      (await admin.patch(`/app/orgs/${A}/members/${membership}`, { status: 'active' })).statusCode,
    ).toBe(204);
    expect((await client.get(`/app/orgs/${A}`)).statusCode).toBe(200);
    expect((await admin.delete(`/app/orgs/${A}/members/${membership}`)).statusCode).toBe(204);
    expect((await client.get(`/app/orgs/${A}`)).statusCode).toBe(404);
  });

  it('assigned custom roles cannot be deleted', async () => {
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(`/app/orgs/${A}/roles`, {
      name: 'Temp role',
      permissions: [],
    });
    const roleId = created.json().role.id as string;
    const user = await createTestUser(ctx.db.db, { name: 'Temp' });
    const membership = await addTestMember(ctx.db.db, A, user.id);
    await owner.request('PUT', `/app/orgs/${A}/members/${membership}/roles`, { roleIds: [roleId] });
    expect((await owner.delete(`/app/orgs/${A}/roles/${roleId}`)).statusCode).toBe(409);
  });

  it('invites with a role and the invitee receives exactly that role', async () => {
    const admin = await as(world.orgA.users.admin);
    const managerRole = await systemRoleId(ctx.db.db, A, 'manager');
    const email = `invitee.${newId()}@example.com`;
    const invited = await admin.post(`/app/orgs/${A}/invitations`, { email, roleId: managerRole });
    expect(invited.statusCode).toBe(201);
    const listed = await admin.get(`/app/orgs/${A}/invitations`);
    expect((listed.json().data as { email: string }[]).map((i) => i.email)).toContain(email);

    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'invitation') throw new Error('no invitation email');
    const invitee = new TestClient(ctx.app);
    const joined = await invitee.post('/app/invitations/register', {
      token: tokenFromLink(sent.link),
      name: 'Invitee',
      password: TEST_PASSWORD,
    });
    expect(joined.statusCode).toBe(201);
    const access = await invitee.get(`/app/orgs/${A}/access`);
    expect((access.json().roles as { systemKey: string }[]).map((r) => r.systemKey)).toEqual([
      'manager',
    ]);
  });

  it('revoked invitations cannot be used', async () => {
    const admin = await as(world.orgA.users.admin);
    const memberRole = await systemRoleId(ctx.db.db, A, 'member');
    const email = `revoked.${newId()}@example.com`;
    const invited = await admin.post(`/app/orgs/${A}/invitations`, { email, roleId: memberRole });
    const id = invited.json().invitation.id as string;
    expect((await admin.delete(`/app/orgs/${A}/invitations/${id}`)).statusCode).toBe(204);
    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'invitation') throw new Error('no invitation email');
    const response = await new TestClient(ctx.app).post('/app/invitations/preview', {
      token: tokenFromLink(sent.link),
    });
    expect(response.statusCode).toBe(400);
  });

  it('members list includes roles', async () => {
    const response = await (
      await as(world.orgA.users.sales)
    ).get(`/app/orgs/${A}/members?limit=100`);
    const owner = (
      response.json().data as { userId: string; roles: { systemKey: string }[] }[]
    ).find((member) => member.userId === world.orgA.users.owner.id);
    expect(owner?.roles.map((role) => role.systemKey)).toEqual(['owner']);
  });
});
