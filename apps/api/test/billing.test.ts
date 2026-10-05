import { tokenFromLink } from '@businessos/auth';
import {
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  addPrice,
  startSubscription,
  changeSubscriptionPlan,
} from '@businessos/billing';
import { plans, subscriptions, withSystem } from '@businessos/database';
import {
  actorFor,
  addTestMember,
  createTestUser,
  createTestWorld,
  systemRoleId,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { eq, min } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, TEST_PASSWORD, TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
});

afterAll(async () => {
  await ctx.close();
});

async function planWith(values: Record<string, unknown>, price?: bigint, isPublic = false) {
  return withSystem(ctx.db.db, async (tx) => {
    // Private unless the test is about the public catalogue. Those sort before every plan
    // already in the shared test database, whose catalogue page is bounded.
    let sortOrder = 0;
    if (isPublic) {
      const [lowest] = await tx.select({ value: min(plans.sortOrder) }).from(plans);
      sortOrder = Math.min(lowest?.value ?? 0, 0) - 1;
    }
    const plan = await createPlan(tx, {
      key: `api-${uniqueSuffix()}`,
      name: `Plan ${uniqueSuffix()}`,
      isPublic,
      sortOrder,
    });
    const version = await createPlanVersion(tx, plan.id, values);
    if (price !== undefined) {
      await addPrice(tx, version.id, { currency: 'BHD', interval: 'month', amountMinor: price });
    }
    await publishPlanVersion(tx, version.id);
    return { plan, version };
  });
}

/** A fresh organization (owner signed in) subscribed to a plan with the given entitlements. */
async function orgOnPlan(values: Record<string, unknown>) {
  const ownerUser = await createTestUser(ctx.db.db, { name: 'Plan owner' });
  const owner = await loginAs(ctx, ownerUser);
  const created = await owner.post('/app/orgs', { name: `Limited ${uniqueSuffix()}` });
  const orgId = created.json().organization.id as string;
  const { version } = await planWith(values);
  await withSystem(ctx.db.db, (tx) =>
    startSubscription(tx, {
      organizationId: orgId,
      planVersionId: version.id,
      status: 'active',
      provider: 'manual',
    }),
  );
  return { owner, ownerUser, orgId, versionId: version.id };
}

describe('seat limit (users.max) cannot be bypassed', () => {
  it('rejects invitations beyond the limit with 402 entitlement_exceeded', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 2 });
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const first = await owner.post(`/app/orgs/${orgId}/invitations`, {
      email: `seat1.${uniqueSuffix()}@example.com`,
      roleId: memberRole,
    });
    expect(first.statusCode).toBe(201);
    const second = await owner.post(`/app/orgs/${orgId}/invitations`, {
      email: `seat2.${uniqueSuffix()}@example.com`,
      roleId: memberRole,
    });
    expect(second.statusCode).toBe(402);
    expect(second.json().error).toMatchObject({ code: 'entitlement_exceeded' });
  });

  it('re-inviting the same email does not consume an extra seat', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 2 });
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const email = `again.${uniqueSuffix()}@example.com`;
    expect(
      (await owner.post(`/app/orgs/${orgId}/invitations`, { email, roleId: memberRole }))
        .statusCode,
    ).toBe(201);
    expect(
      (await owner.post(`/app/orgs/${orgId}/invitations`, { email, roleId: memberRole }))
        .statusCode,
    ).toBe(201);
  });

  it('serializes concurrent invitations at the boundary', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 3 });
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        owner.post(`/app/orgs/${orgId}/invitations`, {
          email: `race${i}.${uniqueSuffix()}@example.com`,
          roleId: memberRole,
        }),
      ),
    );
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(2);
    expect(statuses.filter((status) => status === 402)).toHaveLength(4);
  });

  it('blocks joining after the plan was downgraded below current usage', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 2 });
    const memberRole = await systemRoleId(ctx.db.db, orgId, 'member');
    const email = `late.${uniqueSuffix()}@example.com`;
    await owner.post(`/app/orgs/${orgId}/invitations`, { email, roleId: memberRole });
    const { version: smaller } = await planWith({ 'users.max': 1 });
    await withSystem(ctx.db.db, (tx) => changeSubscriptionPlan(tx, orgId, smaller.id));
    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'invitation') throw new Error('no invitation');
    const joined = await new TestClient(ctx.app).post('/app/invitations/register', {
      token: tokenFromLink(sent.link),
      name: 'Late',
      password: TEST_PASSWORD,
    });
    expect(joined.statusCode).toBe(402);
  });

  it('blocks reactivating a suspended member when no seat is free', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 2 });
    const a = await createTestUser(ctx.db.db, { name: 'Seat A' });
    const membershipA = await addTestMember(ctx.db.db, orgId, a.id);
    expect(
      (await owner.patch(`/app/orgs/${orgId}/members/${membershipA}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(204);
    const b = await createTestUser(ctx.db.db, { name: 'Seat B' });
    await addTestMember(ctx.db.db, orgId, b.id);
    const reactivate = await owner.patch(`/app/orgs/${orgId}/members/${membershipA}`, {
      status: 'active',
    });
    expect(reactivate.statusCode).toBe(402);
  });
});

describe('entitlements endpoint', () => {
  it('shows resolved entitlements and usage to members, read-only', async () => {
    const { owner, orgId } = await orgOnPlan({ 'users.max': 4, 'projects.enabled': true });
    const response = await owner.get(`/app/orgs/${orgId}/billing/entitlements`);
    expect(response.statusCode).toBe(200);
    expect(response.json().entitlements).toMatchObject({
      'users.max': 4,
      'projects.enabled': true,
    });
    expect(response.json().sources['users.max']).toBe('plan');
    expect(response.json().usage['users.max']).toEqual({ used: 1 });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const write = await owner.request(method, `/app/orgs/${orgId}/billing/entitlements`, {
        'users.max': null,
      });
      expect(write.statusCode).toBe(404);
    }
  });

  it('is tenant isolated', async () => {
    const { orgId } = await orgOnPlan({});
    const outsider = await loginAs(ctx, world.orgB.users.owner);
    expect((await outsider.get(`/app/orgs/${orgId}/billing/entitlements`)).statusCode).toBe(404);
  });
});

describe('subscriptions cannot be changed from the client', () => {
  it('exposes no write route for subscriptions and ignores forged fields', async () => {
    const { owner, orgId, versionId } = await orgOnPlan({ 'users.max': 1 });
    const { version: premium } = await planWith({ 'users.max': null });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await owner.request(method, `/app/orgs/${orgId}/billing/subscription`, {
        planVersionId: premium.id,
        status: 'active',
      });
      expect(response.statusCode).toBe(404);
    }
    // Organization updates cannot smuggle billing fields either.
    await owner.patch(`/app/orgs/${orgId}`, { planVersionId: premium.id, subscription: 'growth' });
    const [subscription] = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId)),
    );
    expect(subscription?.planVersionId).toBe(versionId);
  });

  it('requires settings.billing.manage to view the subscription and billing profile', async () => {
    const restricted = await loginAs(ctx, world.orgA.users.restricted);
    const A = world.orgA.organization.id;
    expect((await restricted.get(`/app/orgs/${A}/billing/subscription`)).statusCode).toBe(403);
    expect((await restricted.get(`/app/orgs/${A}/billing/customer`)).statusCode).toBe(403);
    expect(
      (
        await restricted.request('PUT', `/app/orgs/${A}/billing/customer`, {
          legalName: 'X',
          billingEmail: 'x@example.com',
          countryCode: 'BH',
        })
      ).statusCode,
    ).toBe(403);
    const admin = await loginAs(ctx, world.orgA.users.admin);
    const subscription = await admin.get(`/app/orgs/${A}/billing/subscription`);
    expect(subscription.statusCode).toBe(200);
    expect(subscription.json().subscription.status).toBe('active');
  });
});

describe('billing profile', () => {
  it('upserts the billing customer with validation and audits it', async () => {
    const admin = await loginAs(ctx, world.orgA.users.admin);
    const A = world.orgA.organization.id;
    const invalid = await admin.request('PUT', `/app/orgs/${A}/billing/customer`, {
      legalName: '',
      billingEmail: 'nope',
      countryCode: 'Bahrain',
    });
    expect(invalid.statusCode).toBe(400);
    const saved = await admin.request('PUT', `/app/orgs/${A}/billing/customer`, {
      legalName: 'Org A Trading W.L.L.',
      billingEmail: 'Finance@OrgA.example',
      taxId: '200012345600002',
      countryCode: 'bh',
      city: 'Manama',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().customer).toMatchObject({
      billingEmail: 'finance@orga.example',
      countryCode: 'BH',
      organizationId: A,
    });
    const again = await admin.request('PUT', `/app/orgs/${A}/billing/customer`, {
      legalName: 'Org A Trading W.L.L.',
      billingEmail: 'finance@orga.example',
      countryCode: 'BH',
      organizationId: world.orgB.organization.id,
    });
    expect(again.json().customer.organizationId).toBe(A);
    const audit = await admin.get(`/app/orgs/${A}/audit-logs?action=billing.profile_updated`);
    expect(audit.json().data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('plan catalogue', () => {
  it('lists published public plans with BHD prices as decimal strings', async () => {
    const { plan } = await planWith({ 'users.max': 9 }, 15_000n, true);
    const client = await loginAs(ctx, world.orgA.users.sales);
    const response = await client.get('/app/billing/plans');
    expect(response.statusCode).toBe(200);
    const listed = (response.json().data as { id: string; prices: unknown[] }[]).find(
      (entry) => entry.id === plan.id,
    );
    expect(listed?.prices).toEqual([
      expect.objectContaining({ amount: '15.000', currency: 'BHD', interval: 'month' }),
    ]);
    // Leave the shared catalogue as it was.
    await withSystem(ctx.db.db, (tx) =>
      tx.update(plans).set({ isPublic: false }).where(eq(plans.id, plan.id)),
    );
  });

  it('requires a session', async () => {
    expect((await new TestClient(ctx.app).get('/app/billing/plans')).statusCode).toBe(401);
  });
});

describe('fixture sanity', () => {
  it('fixture organizations are subscribed', async () => {
    const actor = await actorFor(ctx.db.db, world.orgA.organization.id, world.orgA.users.owner.id);
    expect(actor.isOwner).toBe(true);
  });
});
