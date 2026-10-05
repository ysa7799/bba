import {
  createDatabase,
  membershipRoles,
  memberships,
  planEntitlements,
  plans,
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
import {
  createPlan,
  createPlanVersion,
  ENTITLEMENTS,
  latestPublishedVersion,
  publishPlanVersion,
  startSubscription,
} from '@businessos/billing';
import type { SystemRoleKey } from '@businessos/permissions';
import { and, eq, sql } from 'drizzle-orm';
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

  // Fixture organizations are on a generous plan so tests exercise features, not limits.
  const planVersionId = await ensureTestPlan(db);
  await subscribeTestOrganization(db, orgA.id, planVersionId);
  await subscribeTestOrganization(db, orgB.id, planVersionId);

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

const TEST_PLAN_KEY = 'test-unlimited';

/**
 * A generous, non-default plan for fixtures (idempotent; safe under parallel test files).
 * Returns the published version id.
 */
export async function ensureTestPlan(db: Database): Promise<string> {
  // System scope: platform catalogue fixture.
  return withSystem(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${TEST_PLAN_KEY}))`);
    const [existing] = await tx.select().from(plans).where(eq(plans.key, TEST_PLAN_KEY));
    const plan =
      existing ??
      (await createPlan(tx, { key: TEST_PLAN_KEY, name: 'Test unlimited', isPublic: false }));
    const published = await latestPublishedVersion(tx, plan.id);
    if (published) {
      // Reuse it unless the entitlement catalogue gained keys since it was published (a key
      // missing from the version would silently fall back to its default limit).
      const keys = await tx
        .select({ key: planEntitlements.key })
        .from(planEntitlements)
        .where(eq(planEntitlements.planVersionId, published.id));
      const present = new Set(keys.map((row) => row.key));
      if (Object.keys(ENTITLEMENTS).every((key) => present.has(key))) return published.id;
    }
    const values: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(ENTITLEMENTS)) {
      values[key] = definition.kind === 'feature' ? true : null;
    }
    const version = await createPlanVersion(tx, plan.id, values);
    await publishPlanVersion(tx, version.id);
    return version.id;
  });
}

export async function subscribeTestOrganization(
  db: Database,
  organizationId: string,
  planVersionId: string,
): Promise<void> {
  // System scope: subscription state only changes through system paths.
  await withSystem(db, (tx) =>
    startSubscription(tx, { organizationId, planVersionId, status: 'active', provider: 'manual' }),
  );
}
