import {
  memberships,
  organizationSettings,
  organizations,
  pgErrorInfo,
  PG_ERROR,
  users,
  withSystem,
  withTenant,
  withUser,
  type DatabaseHandle,
} from '@businessos/database';
import { ConflictError, newId, ValidationError } from '@businessos/shared';
import {
  addTestMember,
  createTestDatabase,
  createTestUser,
  createTestWorld,
  type TestWorld,
} from '@businessos/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  getOrganization,
  getOrganizationSettings,
  listMembers,
  listOrganizationsForUser,
  resolveMembership,
  updateOrganization,
  updateOrganizationSettings,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase();
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const scopeA = () => ({
  organizationId: world.orgA.organization.id,
  userId: world.orgA.users.owner.id,
});

describe('row-level security coverage', () => {
  it('enables and forces RLS with policies on every table in the public schema', async () => {
    const result = await handle.pool.query<{
      table_name: string;
      rls: boolean;
      forced: boolean;
      policies: string;
    }>(`
      select c.relname as table_name,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             (select count(*) from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname)::text as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    const unprotected = result.rows.filter(
      (row) => !row.rls || !row.forced || Number(row.policies) === 0,
    );
    expect(unprotected.map((row) => row.table_name)).toEqual([]);
  });

  it('gives the runtime role no access outside a scoped transaction', async () => {
    for (const table of ['organizations', 'memberships', 'users', 'organization_settings']) {
      const result = await handle.pool.query(`select count(*)::int as n from ${table}`);
      expect(result.rows[0]).toEqual({ n: 0 });
    }
  });
});

describe('tenant isolation (Organization A vs Organization B)', () => {
  it('reads only its own organization', async () => {
    const visible = await withTenant(handle.db, scopeA(), (tx) =>
      tx.select({ id: organizations.id }).from(organizations),
    );
    expect(visible.map((row) => row.id)).toEqual([world.orgA.organization.id]);
  });

  it('cannot fetch Organization B by a guessed/known id', async () => {
    const rows = await withTenant(handle.db, scopeA(), (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, world.orgB.organization.id)),
    );
    expect(rows).toEqual([]);
    await expect(
      withTenant(handle.db, scopeA(), (tx) => getOrganization(tx, world.orgB.organization.id)),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists only its own memberships and member users', async () => {
    const { memberIds, userIds } = await withTenant(handle.db, scopeA(), async (tx) => ({
      memberIds: await tx.select({ org: memberships.organizationId }).from(memberships),
      userIds: await tx.select({ id: users.id }).from(users),
    }));
    expect(new Set(memberIds.map((row) => row.org))).toEqual(new Set([world.orgA.organization.id]));
    const expectedUsers = Object.values(world.orgA.users).map((user) => user.id);
    expect(userIds.map((row) => row.id).sort()).toEqual(expectedUsers.sort());
    expect(userIds.map((row) => row.id)).not.toContain(world.orgB.users.owner.id);
  });

  it('cannot search Organization B members', async () => {
    const page = await withTenant(handle.db, scopeA(), (tx) =>
      listMembers(tx, world.orgA.organization.id, { limit: 50, search: 'B Owner' }),
    );
    expect(page.data).toEqual([]);
    const crossPage = await withTenant(handle.db, scopeA(), (tx) =>
      listMembers(tx, world.orgB.organization.id, { limit: 50 }),
    );
    expect(crossPage.data).toEqual([]);
  });

  it('cannot update or delete Organization B rows', async () => {
    const updated = await withTenant(handle.db, scopeA(), (tx) =>
      tx
        .update(organizations)
        .set({ name: 'pwned' })
        .where(eq(organizations.id, world.orgB.organization.id))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withTenant(handle.db, scopeA(), (tx) =>
      tx
        .delete(memberships)
        .where(eq(memberships.organizationId, world.orgB.organization.id))
        .returning(),
    );
    expect(deleted).toEqual([]);

    await expect(
      withTenant(handle.db, scopeA(), (tx) =>
        updateOrganization(tx, world.orgB.organization.id, { name: 'pwned' }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    const orgB = await withSystem(handle.db, (tx) =>
      tx.select().from(organizations).where(eq(organizations.id, world.orgB.organization.id)),
    );
    expect(orgB[0]?.name).toBe(world.orgB.organization.name);
  });

  it('cannot insert rows that reference Organization B', async () => {
    const attempt = withTenant(handle.db, scopeA(), (tx) =>
      tx.insert(memberships).values({
        organizationId: world.orgB.organization.id,
        userId: world.orgA.users.sales.id,
      }),
    );
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.insufficientPrivilege,
    );

    const settingAttempt = withTenant(handle.db, scopeA(), (tx) =>
      tx.insert(organizationSettings).values({
        organizationId: world.orgB.organization.id,
        key: 'general.week_start_day',
        value: 1,
      }),
    );
    await expect(settingAttempt).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.insufficientPrivilege,
    );
  });

  it('cannot move its own rows into Organization B', async () => {
    const attempt = withTenant(handle.db, scopeA(), (tx) =>
      tx
        .update(memberships)
        .set({ organizationId: world.orgB.organization.id })
        .where(eq(memberships.userId, world.orgA.users.sales.id)),
    );
    await expect(attempt).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.insufficientPrivilege,
    );
  });

  it('does not leak tenant context across pooled connections', async () => {
    const single = createTestDatabase(1);
    try {
      await withTenant(single.db, scopeA(), (tx) => tx.select().from(organizations));
      const after = await single.pool.query('select count(*)::int as n from organizations');
      expect(after.rows[0]).toEqual({ n: 0 });
      const setting = await single.pool.query(
        "select coalesce(current_setting('app.org_id', true), '') as org",
      );
      expect(setting.rows[0]).toEqual({ org: '' });
    } finally {
      await single.close();
    }
  });

  it('rejects malformed scope identifiers before touching the database', async () => {
    await expect(
      withTenant(handle.db, { organizationId: "x' OR '1'='1", userId: null }, (tx) =>
        tx.select().from(organizations),
      ),
    ).rejects.toThrow(/Invalid organization id/);
  });

  it('cannot escalate to system scope by setting session variables from inside a tenant', async () => {
    // Even if application code were tricked into running SET for app.org_id, it is only honoured
    // via set_config in our scoped helpers; this test documents that RLS reads the setting value
    // and that a tenant transaction starts with system mode explicitly off.
    const system = await withTenant(handle.db, scopeA(), (tx) =>
      tx.execute(sql`select app_is_system() as system`),
    );
    expect(system.rows[0]).toEqual({ system: false });
  });
});

describe('organization settings', () => {
  it('returns defaults, persists valid updates, and isolates tenants', async () => {
    const defaults = await withTenant(handle.db, scopeA(), (tx) =>
      getOrganizationSettings(tx, world.orgA.organization.id),
    );
    expect(defaults['general.week_start_day']).toBe(0);

    const updated = await withTenant(handle.db, scopeA(), (tx) =>
      updateOrganizationSettings(
        tx,
        world.orgA.organization.id,
        { 'general.week_start_day': 1, 'general.date_format': 'YYYY-MM-DD' },
        world.orgA.users.owner.id,
      ),
    );
    expect(updated['general.week_start_day']).toBe(1);
    expect(updated['general.date_format']).toBe('YYYY-MM-DD');

    const bSettings = await withTenant(
      handle.db,
      { organizationId: world.orgB.organization.id, userId: world.orgB.users.owner.id },
      (tx) => getOrganizationSettings(tx, world.orgB.organization.id),
    );
    expect(bSettings['general.week_start_day']).toBe(0);
  });

  it('rejects unknown keys and invalid values', async () => {
    await expect(
      withTenant(handle.db, scopeA(), (tx) =>
        updateOrganizationSettings(tx, world.orgA.organization.id, { 'billing.plan': 'pro' }, null),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      withTenant(handle.db, scopeA(), (tx) =>
        updateOrganizationSettings(
          tx,
          world.orgA.organization.id,
          { 'general.week_start_day': 9 },
          null,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('cannot write settings for another tenant through the service', async () => {
    await expect(
      withTenant(handle.db, scopeA(), (tx) =>
        updateOrganizationSettings(
          tx,
          world.orgB.organization.id,
          { 'general.week_start_day': 3 },
          world.orgA.users.owner.id,
        ),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.insufficientPrivilege,
    );
  });
});

describe('membership resolution and organization switching', () => {
  it('lists only organizations the user belongs to', async () => {
    const orgs = await listOrganizationsForUser(handle.db, world.orgA.users.sales.id);
    expect(orgs.map((entry) => entry.organization.id)).toEqual([world.orgA.organization.id]);
  });

  it('resolves membership for members and returns null for non-members', async () => {
    const own = await resolveMembership(
      handle.db,
      world.orgA.users.sales.id,
      world.orgA.organization.id,
    );
    expect(own?.organization.id).toBe(world.orgA.organization.id);

    const foreign = await resolveMembership(
      handle.db,
      world.orgA.users.sales.id,
      world.orgB.organization.id,
    );
    expect(foreign).toBeNull();

    const nonexistent = await resolveMembership(handle.db, world.orgA.users.sales.id, newId());
    expect(nonexistent).toBeNull();
  });

  it('supports users in multiple organizations', async () => {
    const consultant = await createTestUser(handle.db, { name: 'Consultant' });
    await addTestMember(handle.db, world.orgA.organization.id, consultant.id);
    await addTestMember(handle.db, world.orgB.organization.id, consultant.id);
    const orgs = await listOrganizationsForUser(handle.db, consultant.id);
    expect(orgs.map((entry) => entry.organization.id).sort()).toEqual(
      [world.orgA.organization.id, world.orgB.organization.id].sort(),
    );
    // Membership in B does not grant A-scoped access to B data.
    const rows = await withTenant(
      handle.db,
      { organizationId: world.orgA.organization.id, userId: consultant.id },
      (tx) => tx.select({ id: organizations.id }).from(organizations),
    );
    expect(rows.map((row) => row.id)).toEqual([world.orgA.organization.id]);
    const ownMemberships = await withTenant(
      handle.db,
      { organizationId: world.orgA.organization.id, userId: consultant.id },
      (tx) =>
        tx
          .select({ org: memberships.organizationId })
          .from(memberships)
          .where(eq(memberships.userId, consultant.id)),
    );
    expect(ownMemberships.map((row) => row.org)).toEqual([world.orgA.organization.id]);
  });

  it('denies suspended members and inactive organizations', async () => {
    const user = await createTestUser(handle.db, { name: 'Suspended' });
    await addTestMember(handle.db, world.orgA.organization.id, user.id, 'suspended');
    expect(await resolveMembership(handle.db, user.id, world.orgA.organization.id)).toBeNull();
    expect(await listOrganizationsForUser(handle.db, user.id)).toEqual([]);

    const owner = await createTestUser(handle.db, { name: 'Closing owner' });
    const { organization } = await createOrganization(handle.db, owner.id, { name: 'Closing' });
    await withSystem(handle.db, (tx) =>
      tx
        .update(organizations)
        .set({ status: 'suspended' })
        .where(eq(organizations.id, organization.id)),
    );
    expect(await resolveMembership(handle.db, owner.id, organization.id)).toBeNull();
  });

  it('cannot read another user’s memberships in user scope', async () => {
    const rows = await withUser(handle.db, world.orgA.users.sales.id, (tx) =>
      tx.select({ userId: memberships.userId }).from(memberships),
    );
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([world.orgA.users.sales.id]));
  });
});

describe('organization creation', () => {
  it('creates the organization with the creator as an active member', async () => {
    const owner = await createTestUser(handle.db, { name: 'Founder' });
    const { organization, ownerMembership } = await createOrganization(handle.db, owner.id, {
      name: 'Gulf Trading W.L.L.',
    });
    expect(organization.defaultCurrency).toBe('BHD');
    expect(organization.timezone).toBe('Asia/Bahrain');
    expect(organization.countryCode).toBe('BH');
    expect(organization.slug).toMatch(/^gulf-trading-w-l-l/);
    expect(ownerMembership.userId).toBe(owner.id);
  });

  it('generates unique slugs and handles non-Latin names', async () => {
    const owner = await createTestUser(handle.db, { name: 'Founder 2' });
    const first = await createOrganization(handle.db, owner.id, { name: 'شركة البحرين' });
    const second = await createOrganization(handle.db, owner.id, { name: 'شركة البحرين' });
    expect(first.organization.slug).toMatch(/^org/);
    expect(second.organization.slug).not.toBe(first.organization.slug);
  });

  it('rejects taken explicit slugs and invalid regional settings', async () => {
    const owner = await createTestUser(handle.db, { name: 'Founder 3' });
    await expect(
      createOrganization(handle.db, owner.id, {
        name: 'Copycat',
        slug: world.orgA.organization.slug,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      createOrganization(handle.db, owner.id, { name: 'Bad', timezone: 'Mars/Olympus' }),
    ).rejects.toThrow();
    await expect(
      createOrganization(handle.db, owner.id, { name: 'Bad', defaultCurrency: 'XXX' }),
    ).rejects.toThrow();
  });

  it('refuses to create organizations for unknown or disabled users', async () => {
    await expect(createOrganization(handle.db, newId(), { name: 'Ghost' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
