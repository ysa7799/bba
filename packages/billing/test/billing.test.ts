import {
  billingEvents,
  entitlementOverrides,
  invitations,
  outboxEvents,
  pgErrorInfo,
  PG_ERROR,
  plans,
  subscriptions,
  usageCounters,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Tx,
} from '@businessos/database';
import { EntitlementExceededError, newId, ValidationError } from '@businessos/shared';
import {
  addTestMember,
  createTestDatabase,
  createTestUser,
  uniqueSuffix,
} from '@businessos/testing';
import { createOrganization } from '@businessos/organizations';
import { and, eq, min } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrice,
  assertSeatsAvailable,
  cancelSubscription,
  changeSubscriptionPlan,
  checkUsage,
  consumeUsage,
  createPlan,
  createPlanVersion,
  fallbackEntitlements,
  getQuotaUsage,
  listPublicPlans,
  monthPeriodStart,
  parseEntitlementValue,
  publishPlanVersion,
  requireFeature,
  resolveEntitlements,
  setSubscriptionStatus,
  startSubscription,
  subscribeToDefaultPlan,
} from '../src';

let handle: DatabaseHandle;

beforeAll(() => {
  handle = createTestDatabase(8);
});

afterAll(async () => {
  await handle.close();
});

class Rollback extends Error {}

/** Runs `fn` in a system transaction that is always rolled back (keeps the shared DB clean). */
async function inRolledBackTx(
  fn: (tx: Parameters<Parameters<typeof withSystem>[1]>[0]) => Promise<void>,
) {
  await expect(
    withSystem(handle.db, async (tx) => {
      await fn(tx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function newOrg(options: { timezone?: string } = {}) {
  const owner = await createTestUser(handle.db, { name: 'Billing owner' });
  const { organization } = await createOrganization(handle.db, owner.id, {
    name: `Billing ${uniqueSuffix()}`,
    ...(options.timezone ? { timezone: options.timezone } : {}),
  });
  return { organization, owner };
}

async function newPlanVersion(
  values: Record<string, unknown>,
  options: { publish?: boolean; isPublic?: boolean } = {},
) {
  return withSystem(handle.db, async (tx) => {
    // Test plans are private unless a test is about the public catalogue. Those sort before
    // every plan already in the shared test database, whose catalogue page is bounded.
    let sortOrder = 0;
    if (options.isPublic) {
      const [lowest] = await tx.select({ value: min(plans.sortOrder) }).from(plans);
      sortOrder = Math.min(lowest?.value ?? 0, 0) - 1;
    }
    const plan = await createPlan(tx, {
      key: `plan-${uniqueSuffix()}`,
      name: 'Test plan',
      isPublic: options.isPublic ?? false,
      sortOrder,
    });
    const version = await createPlanVersion(tx, plan.id, values);
    if (options.publish !== false) await publishPlanVersion(tx, version.id);
    return { plan, version };
  });
}

async function subscribe(organizationId: string, planVersionId: string) {
  return withSystem(handle.db, (tx) =>
    startSubscription(tx, { organizationId, planVersionId, status: 'active', provider: 'manual' }),
  );
}

function tenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>) {
  return withTenant(handle.db, { organizationId, userId: null }, fn);
}

describe('entitlement registry', () => {
  it('validates values by kind', () => {
    expect(parseEntitlementValue('projects.enabled', true)).toBe(true);
    expect(parseEntitlementValue('users.max', 10)).toBe(10);
    expect(parseEntitlementValue('users.max', null)).toBeNull();
    expect(() => parseEntitlementValue('projects.enabled', 1)).toThrow();
    expect(() => parseEntitlementValue('users.max', -1)).toThrow();
    expect(() => parseEntitlementValue('users.max', 1.5)).toThrow();
  });

  it('computes monthly periods in the organization timezone', () => {
    // 21:30 UTC on Jan 31 is already Feb 1 in Bahrain (UTC+3).
    const at = new Date('2026-01-31T21:30:00Z');
    expect(monthPeriodStart(at, 'Asia/Bahrain')).toBe('2026-02-01');
    expect(monthPeriodStart(at, 'UTC')).toBe('2026-01-01');
    expect(monthPeriodStart(at, 'America/New_York')).toBe('2026-01-01');
  });
});

describe('plan catalogue', () => {
  it('versions plans and only exposes published public versions', async () => {
    const { plan, version } = await newPlanVersion(
      { 'users.max': 5 },
      { publish: false, isPublic: true },
    );
    expect(version.version).toBe(1);
    const before = await withSystem(handle.db, (tx) => listPublicPlans(tx));
    expect(before.find((entry) => entry.id === plan.id)).toBeUndefined();
    await withSystem(handle.db, async (tx) => {
      await addPrice(tx, version.id, { currency: 'BHD', interval: 'month', amountMinor: 12_500n });
      await publishPlanVersion(tx, version.id);
      const second = await createPlanVersion(tx, plan.id, { 'users.max': 8 });
      expect(second.version).toBe(2);
    });
    const after = await withSystem(handle.db, (tx) => listPublicPlans(tx));
    const listed = after.find((entry) => entry.id === plan.id);
    expect(listed).toMatchObject({ version: 1, entitlements: { 'users.max': 5 } });
    expect(listed?.prices).toEqual([
      expect.objectContaining({ currency: 'BHD', interval: 'month', amountMinor: 12_500n }),
    ]);
    // Leave the shared catalogue as it was.
    await withSystem(handle.db, (tx) =>
      tx.update(plans).set({ isPublic: false }).where(eq(plans.id, plan.id)),
    );
  });

  it('rejects unknown entitlements, invalid values, negative prices and unknown currencies', async () => {
    await expect(newPlanVersion({ 'superpowers.enabled': true })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(newPlanVersion({ 'users.max': 'lots' })).rejects.toBeInstanceOf(ValidationError);
    const { version } = await newPlanVersion({});
    await expect(
      withSystem(handle.db, (tx) =>
        addPrice(tx, version.id, { currency: 'BHD', interval: 'month', amountMinor: -1n }),
      ),
    ).rejects.toThrow();
    await expect(
      withSystem(handle.db, (tx) =>
        addPrice(tx, version.id, { currency: 'XXX' as never, interval: 'month', amountMinor: 1n }),
      ),
    ).rejects.toThrow();
  });

  it('refuses subscriptions to unpublished versions', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({}, { publish: false });
    await expect(subscribe(organization.id, version.id)).rejects.toThrow(/published/);
  });
});

describe('entitlement resolution', () => {
  it('falls back to the baseline without a subscription', async () => {
    const { organization } = await newOrg();
    const resolved = await tenant(organization.id, (tx) =>
      resolveEntitlements(tx, organization.id),
    );
    expect(resolved.values).toEqual(fallbackEntitlements());
    expect(resolved.subscriptionId).toBeNull();
    expect(new Set(Object.values(resolved.sources))).toEqual(new Set(['fallback']));
  });

  it('applies plan values, keeps them while past_due and drops them when paused', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'users.max': 25, 'projects.enabled': true });
    await subscribe(organization.id, version.id);
    const active = await tenant(organization.id, (tx) => resolveEntitlements(tx, organization.id));
    expect(active.values['users.max']).toBe(25);
    expect(active.values['projects.enabled']).toBe(true);
    expect(active.sources['users.max']).toBe('plan');
    // Unspecified keys keep the baseline.
    expect(active.values['api.enabled']).toBe(false);

    await withSystem(handle.db, (tx) => setSubscriptionStatus(tx, organization.id, 'past_due'));
    expect(
      (await tenant(organization.id, (tx) => resolveEntitlements(tx, organization.id))).values[
        'users.max'
      ],
    ).toBe(25);

    await withSystem(handle.db, (tx) => setSubscriptionStatus(tx, organization.id, 'paused'));
    expect(
      (await tenant(organization.id, (tx) => resolveEntitlements(tx, organization.id))).values[
        'users.max'
      ],
    ).toBe(fallbackEntitlements()['users.max']);
  });

  it('lets unexpired overrides win over the plan', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'api.enabled': false });
    await subscribe(organization.id, version.id);
    await withSystem(handle.db, (tx) =>
      tx.insert(entitlementOverrides).values([
        {
          organizationId: organization.id,
          key: 'api.enabled',
          value: { value: true },
          reason: 'pilot customer',
        },
        {
          organizationId: organization.id,
          key: 'users.max',
          value: { value: 99 },
          reason: 'expired promo',
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          organizationId: organization.id,
          key: 'nonsense.key',
          value: { value: true },
          reason: 'ignored',
        },
      ]),
    );
    const resolved = await tenant(organization.id, (tx) =>
      resolveEntitlements(tx, organization.id),
    );
    expect(resolved.values['api.enabled']).toBe(true);
    expect(resolved.sources['api.enabled']).toBe('override');
    expect(resolved.values['users.max']).toBe(fallbackEntitlements()['users.max']);
    await expect(
      tenant(organization.id, (tx) => requireFeature(tx, organization.id, 'helpdesk.enabled')),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
    await tenant(organization.id, (tx) => requireFeature(tx, organization.id, 'api.enabled'));
  });

  it('records plan changes as billing and domain events', async () => {
    const { organization } = await newOrg();
    const small = await newPlanVersion({ 'users.max': 2 });
    const large = await newPlanVersion({ 'users.max': 20 });
    await subscribe(organization.id, small.version.id);
    await withSystem(handle.db, (tx) =>
      changeSubscriptionPlan(tx, organization.id, large.version.id),
    );
    const resolved = await tenant(organization.id, (tx) =>
      resolveEntitlements(tx, organization.id),
    );
    expect(resolved.values['users.max']).toBe(20);
    const history = await withSystem(handle.db, (tx) =>
      tx.select().from(billingEvents).where(eq(billingEvents.organizationId, organization.id)),
    );
    expect(history.map((event) => event.type)).toEqual(
      expect.arrayContaining(['subscription.started', 'subscription.plan_changed']),
    );
    const events = await withSystem(handle.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.organizationId, organization.id)),
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['subscription.started', 'subscription.changed']),
    );
    await withSystem(handle.db, (tx) =>
      cancelSubscription(tx, organization.id, { atPeriodEnd: false }),
    );
    expect(
      (await tenant(organization.id, (tx) => resolveEntitlements(tx, organization.id))).values[
        'users.max'
      ],
    ).toBe(fallbackEntitlements()['users.max']);
  });

  it('subscribes new organizations to the default plan', async () => {
    const { organization } = await newOrg();
    await inRolledBackTx(async (tx) => {
      await tx.update(plans).set({ isDefault: false }).where(eq(plans.isDefault, true));
      const plan = await createPlan(tx, {
        key: `default-${uniqueSuffix()}`,
        name: 'Default',
        isDefault: true,
      });
      const version = await createPlanVersion(tx, plan.id, { 'users.max': 7 });
      await publishPlanVersion(tx, version.id);
      const subscription = await subscribeToDefaultPlan(tx, organization.id);
      expect(subscription?.planVersionId).toBe(version.id);
      // Idempotent: a second call does nothing while a live subscription exists.
      expect(await subscribeToDefaultPlan(tx, organization.id)).toBeNull();
    });
  });

  it('allows only one live subscription per organization', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({});
    await subscribe(organization.id, version.id);
    await expect(subscribe(organization.id, version.id)).rejects.toSatisfy(
      (error: unknown) => pgErrorInfo(error)?.code === PG_ERROR.uniqueViolation,
    );
  });
});

describe('tenant cannot write billing state (RLS)', () => {
  it('cannot create, upgrade or delete subscriptions, overrides, events or catalogue rows', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'users.max': 1 });
    await subscribe(organization.id, version.id);
    const generous = await newPlanVersion({ 'users.max': null });

    const insufficient = (error: unknown) =>
      pgErrorInfo(error)?.code === PG_ERROR.insufficientPrivilege;

    // Upgrade attempts: updates silently match no rows; inserts are rejected.
    const upgraded = await tenant(organization.id, (tx) =>
      tx
        .update(subscriptions)
        .set({ planVersionId: generous.version.id })
        .where(eq(subscriptions.organizationId, organization.id))
        .returning(),
    );
    expect(upgraded).toEqual([]);
    await expect(
      tenant(organization.id, (tx) =>
        tx.insert(entitlementOverrides).values({
          organizationId: organization.id,
          key: 'users.max',
          value: { value: null },
          reason: 'self-granted',
        }),
      ),
    ).rejects.toSatisfy(insufficient);
    await expect(
      tenant(organization.id, (tx) =>
        tx.insert(billingEvents).values({ organizationId: organization.id, type: 'forged' }),
      ),
    ).rejects.toSatisfy(insufficient);
    await expect(
      tenant(organization.id, (tx) =>
        tx.insert(plans).values({ key: `evil-${uniqueSuffix()}`, name: 'Evil' }),
      ),
    ).rejects.toSatisfy(insufficient);
    const deleted = await tenant(organization.id, (tx) =>
      tx.delete(subscriptions).where(eq(subscriptions.organizationId, organization.id)).returning(),
    );
    expect(deleted).toEqual([]);

    const resolved = await tenant(organization.id, (tx) =>
      resolveEntitlements(tx, organization.id),
    );
    expect(resolved.values['users.max']).toBe(1);
  });

  it('reads only its own subscription', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const { version } = await newPlanVersion({});
    await subscribe(a.organization.id, version.id);
    await subscribe(b.organization.id, version.id);
    const visible = await tenant(a.organization.id, (tx) => tx.select().from(subscriptions));
    expect(visible.map((row) => row.organizationId)).toEqual([a.organization.id]);
  });
});

describe('usage metering', () => {
  it('never exceeds a quota under concurrent consumption', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'email.monthly_limit': 10 });
    await subscribe(organization.id, version.id);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        tenant(organization.id, (tx) =>
          consumeUsage(tx, organization.id, 'email.monthly_limit', 1),
        ),
      ),
    );
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(15);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(EntitlementExceededError);
    }
    const usage = await tenant(organization.id, (tx) =>
      getQuotaUsage(tx, organization.id, 'email.monthly_limit'),
    );
    expect(usage).toMatchObject({ used: 10, limit: 10, remaining: 0 });
  });

  it('consumes once per idempotency key', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'sms.monthly_limit': 100 });
    await subscribe(organization.id, version.id);
    const key = `send-${newId()}`;
    for (let i = 0; i < 3; i += 1) {
      await tenant(organization.id, (tx) =>
        consumeUsage(tx, organization.id, 'sms.monthly_limit', 4, { idempotencyKey: key }),
      );
    }
    const usage = await tenant(organization.id, (tx) =>
      getQuotaUsage(tx, organization.id, 'sms.monthly_limit'),
    );
    expect(usage.used).toBe(4);
  });

  it('rolls back the whole operation when the quota is exceeded', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'ai.monthly_credits': 5 });
    await subscribe(organization.id, version.id);
    await expect(
      tenant(organization.id, async (tx) => {
        await consumeUsage(tx, organization.id, 'ai.monthly_credits', 3, {
          idempotencyKey: 'op-1',
        });
        await consumeUsage(tx, organization.id, 'ai.monthly_credits', 3, {
          idempotencyKey: 'op-2',
        });
      }),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
    const usage = await tenant(organization.id, (tx) =>
      getQuotaUsage(tx, organization.id, 'ai.monthly_credits'),
    );
    expect(usage.used).toBe(0);
  });

  it('treats null quotas as unlimited and checkUsage does not mutate', async () => {
    const { organization } = await newOrg();
    const { version } = await newPlanVersion({ 'whatsapp.monthly_limit': null });
    await subscribe(organization.id, version.id);
    await tenant(organization.id, (tx) =>
      consumeUsage(tx, organization.id, 'whatsapp.monthly_limit', 1_000_000),
    );
    const check = await tenant(organization.id, (tx) =>
      checkUsage(tx, organization.id, 'whatsapp.monthly_limit', 5),
    );
    expect(check).toMatchObject({ allowed: true, limit: null, used: 1_000_000 });
  });

  it('meters by local calendar month', async () => {
    const { organization } = await newOrg({ timezone: 'Asia/Bahrain' });
    const { version } = await newPlanVersion({ 'email.monthly_limit': null });
    await subscribe(organization.id, version.id);
    await tenant(organization.id, (tx) =>
      consumeUsage(tx, organization.id, 'email.monthly_limit', 2, {
        at: new Date('2026-01-31T21:30:00Z'),
      }),
    );
    const counters = await tenant(organization.id, (tx) =>
      tx
        .select()
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.organizationId, organization.id),
            eq(usageCounters.metric, 'email.monthly_limit'),
          ),
        ),
    );
    expect(counters.map((row) => row.periodStart)).toEqual(['2026-02-01']);
  });

  it('cannot consume or read another tenant’s counters', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await expect(
      tenant(a.organization.id, (tx) =>
        consumeUsage(tx, b.organization.id, 'email.monthly_limit', 1),
      ),
    ).rejects.toThrow();
  });
});

describe('seat limits', () => {
  it('counts active members and pending invitations, serialized per organization', async () => {
    const { organization, owner } = await newOrg();
    const { version } = await newPlanVersion({ 'users.max': 3 });
    await subscribe(organization.id, version.id);
    await addTestMember(
      handle.db,
      organization.id,
      (await createTestUser(handle.db, { name: 'M' })).id,
    );
    // 2 used (owner + member). Two concurrent seat reservations: only one fits.
    const reserve = () =>
      tenant(organization.id, async (tx) => {
        await assertSeatsAvailable(tx, organization.id, 1);
        await tx.insert(invitations).values({
          organizationId: organization.id,
          email: `seat.${uniqueSuffix()}@example.com`,
          tokenHash: 'a'.repeat(32) + uniqueSuffix().padEnd(32, '0'),
          roleId: (await tx.query.roles.findFirst({
            where: (roles, { and: both, eq: equals }) =>
              both(
                equals(roles.organizationId, organization.id),
                equals(roles.systemKey, 'member'),
              ),
          }))!.id,
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 3600_000),
        });
      });
    const results = await Promise.allSettled([reserve(), reserve()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected')!;
    expect(rejected.reason).toBeInstanceOf(EntitlementExceededError);
  });
});
