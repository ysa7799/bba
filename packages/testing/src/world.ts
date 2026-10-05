import {
  createDatabase,
  membershipRoles,
  memberships,
  roles,
  users,
  withSystem,
  type Database,
  type DatabaseHandle,
  type Organization,
  type User,
} from '@businessos/database';
import { requireEnv } from '@businessos/database/testing';
import { createOrganization, resolveMembership, type MemberActor } from '@businessos/organizations';
import type { SystemRoleKey } from '@businessos/permissions';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

/** Connects as the runtime role so RLS is enforced in tests. */
export function createTestDatabase(maxConnections = 4): DatabaseHandle {
  return createDatabase({
    url: requireEnv('DATABASE_URL'),
    maxConnections,
    applicationName: 'businessos-test',
  });
}

export function uniqueSuffix(): string {
  return randomBytes(5).toString('hex');
}

export async function createTestUser(
  db: Database,
  input: { name: string; email?: string; emailVerified?: boolean; passwordHash?: string | null },
): Promise<User> {
  const email = (
    input.email ?? `${input.name.replace(/\W+/g, '.')}.${uniqueSuffix()}@test.businessos.dev`
  ).toLowerCase();
  // System scope: test fixture creating a global identity row.
  return withSystem(db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name: input.name,
        passwordHash: input.passwordHash ?? null,
        emailVerifiedAt: input.emailVerified === false ? null : new Date(),
      })
      .returning();
    if (!user) throw new Error('failed to create test user');
    return user;
  });
}

export async function addTestMember(
  db: Database,
  organizationId: string,
  userId: string,
  options: { status?: 'active' | 'suspended'; role?: SystemRoleKey } = {},
): Promise<string> {
  // System scope: fixture setup outside any request.
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .insert(memberships)
      .values({ organizationId, userId, status: options.status ?? 'active' })
      .returning({ id: memberships.id });
    if (!row) throw new Error('failed to add member');
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.organizationId, organizationId),
          eq(roles.systemKey, options.role ?? 'member'),
        ),
      );
    if (!role) throw new Error('system role missing');
    await tx
      .insert(membershipRoles)
      .values({ organizationId, membershipId: row.id, roleId: role.id });
    return row.id;
  });
}

export interface TestOrg<Members extends string> {
  organization: Organization;
  users: Record<Members, User>;
}

export interface TestWorld {
  orgA: TestOrg<'owner' | 'admin' | 'manager' | 'sales' | 'restricted'>;
  orgB: TestOrg<'owner' | 'admin'>;
}

/**
 * Standard two-tenant fixture (docs/TESTING.md):
 *   Organization A: owner, admin, manager, sales, restricted
 *   Organization B: owner, admin
 * Every call creates fresh, uniquely named data so test files can run in parallel.
 */
export async function createTestWorld(db: Database): Promise<TestWorld> {
  const suffix = uniqueSuffix();
  const aOwner = await createTestUser(db, { name: `A Owner ${suffix}` });
  const bOwner = await createTestUser(db, { name: `B Owner ${suffix}` });
  const { organization: orgA } = await createOrganization(db, aOwner.id, {
    name: `Org A ${suffix}`,
  });
  const { organization: orgB } = await createOrganization(db, bOwner.id, {
    name: `Org B ${suffix}`,
  });

  const aUsers = {
    admin: await createTestUser(db, { name: `A Admin ${suffix}` }),
    manager: await createTestUser(db, { name: `A Manager ${suffix}` }),
    sales: await createTestUser(db, { name: `A Sales ${suffix}` }),
    restricted: await createTestUser(db, { name: `A Restricted ${suffix}` }),
  };
  const aRoles: Record<keyof typeof aUsers, SystemRoleKey> = {
    admin: 'admin',
    manager: 'manager',
    sales: 'member',
    restricted: 'restricted',
  };
  for (const [key, user] of Object.entries(aUsers) as [keyof typeof aUsers, User][]) {
    await addTestMember(db, orgA.id, user.id, { role: aRoles[key] });
  }
  const bAdmin = await createTestUser(db, { name: `B Admin ${suffix}` });
  await addTestMember(db, orgB.id, bAdmin.id, { role: 'admin' });

  return {
    orgA: { organization: orgA, users: { owner: aOwner, ...aUsers } },
    orgB: { organization: orgB, users: { owner: bOwner, admin: bAdmin } },
  };
}

/** Resolves a fixture member into the actor shape used by authorization-aware services. */
export async function actorFor(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<MemberActor> {
  const resolved = await resolveMembership(db, userId, organizationId);
  if (!resolved) throw new Error('user is not an active member');
  return {
    userId,
    membershipId: resolved.membership.id,
    permissions: resolved.access.permissions,
    isOwner: resolved.access.isOwner,
  };
}

export async function systemRoleId(
  db: Database,
  organizationId: string,
  key: SystemRoleKey,
): Promise<string> {
  // System scope: fixture lookup.
  return withSystem(db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, organizationId), eq(roles.systemKey, key)));
    if (!role) throw new Error(`system role ${key} missing`);
    return role.id;
  });
}
