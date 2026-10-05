import { SYSTEM_AUDIT_CONTEXT } from '@businessos/audit';
import {
  addPrice,
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  resolveEntitlements,
} from '@businessos/billing';
import {
  billingEvents,
  checkoutSessions,
  outboxEvents,
  paymentWebhookEvents,
  payments,
  subscriptionItems,
  subscriptions,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import { createOrganization } from '@businessos/organizations';
import { money, UnauthenticatedError } from '@businessos/shared';
import { createTestDatabase, createTestUser, uniqueSuffix } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addInterval,
  createSubscriptionCheckout,
  FakePaymentProvider,
  handlePaymentWebhook,
  PaymentProviderRegistry,
  runSubscriptionMaintenance,
  syncPayment,
  type PaymentServices,
} from '../src';

let handle: DatabaseHandle;
let fake: FakePaymentProvider;
let services: PaymentServices;

beforeAll(() => {
  handle = createTestDatabase(8);
  fake = new FakePaymentProvider({
    webhookSecret: 'test-webhook-secret-123456',
    checkoutBaseUrl: 'http://localhost:3000/dev/fake-checkout',
  });
  services = {
    db: handle.db,
    providers: new PaymentProviderRegistry().register(fake),
    checkoutProvider: 'fake',
    appUrl: 'http://localhost:3000',
    apiPublicUrl: 'http://localhost:4000',
  };
});

afterAll(async () => {
  await handle.close();
});

async function paidPlan(amountMinor = 15_000n, interval: 'month' | 'year' = 'month') {
  return withSystem(handle.db, async (tx) => {
    const plan = await createPlan(tx, {
      key: `paid-${uniqueSuffix()}`,
      name: 'Paid',
      isPublic: true,
      sortOrder: 50,
    });
    const version = await createPlanVersion(tx, plan.id, { 'users.max': 25, 'api.enabled': true });
    const price = await addPrice(tx, version.id, { currency: 'BHD', interval, amountMinor });
    await publishPlanVersion(tx, version.id);
    return { plan, version, price };
  });
}

async function setup(amountMinor?: bigint) {
  const user = await createTestUser(handle.db, { name: 'Payer' });
  const { organization } = await createOrganization(handle.db, user.id, {
    name: `Pay ${uniqueSuffix()}`,
  });
  const { version, price } = await paidPlan(amountMinor);
  const checkout = await createSubscriptionCheckout(
    services,
    {
      organizationId: organization.id,
      userId: user.id,
      audit: SYSTEM_AUDIT_CONTEXT,
      correlationId: 'req-1',
    },
    { priceId: price.id },
  );
  const [payment] = await withSystem(handle.db, (tx) =>
    tx.select().from(payments).where(eq(payments.id, checkout.paymentId)),
  );
  return { user, organization, version, price, checkout, payment: payment! };
}

async function subscriptionOf(organizationId: string) {
  const [row] = await withSystem(handle.db, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)),
  );
  return row;
}

describe('checkout creation', () => {
  it('prices the payment server-side and links it to the provider charge', async () => {
    const { payment, checkout } = await setup(15_000n);
    expect(payment).toMatchObject({
      status: 'pending',
      amountMinor: 15_000n,
      currency: 'BHD',
      provider: 'fake',
      purpose: 'subscription',
    });
    expect(payment.providerPaymentId).toMatch(/^fake_/);
    expect(checkout.redirectUrl).toContain('/dev/fake-checkout?payment=');
  });

  it('refuses archived/private prices and free prices', async () => {
    const user = await createTestUser(handle.db, { name: 'P' });
    const { organization } = await createOrganization(handle.db, user.id, {
      name: `P ${uniqueSuffix()}`,
    });
    const privatePrice = await withSystem(handle.db, async (tx) => {
      const plan = await createPlan(tx, {
        key: `private-${uniqueSuffix()}`,
        name: 'Private',
        isPublic: false,
      });
      const version = await createPlanVersion(tx, plan.id, {});
      const price = await addPrice(tx, version.id, {
        currency: 'BHD',
        interval: 'month',
        amountMinor: 1_000n,
      });
      await publishPlanVersion(tx, version.id);
      return price;
    });
    const context = {
      organizationId: organization.id,
      userId: user.id,
      audit: SYSTEM_AUDIT_CONTEXT,
      correlationId: 'r',
    };
    await expect(
      createSubscriptionCheckout(services, context, { priceId: privatePrice.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const { price: free } = await paidPlan(0n);
    await expect(
      createSubscriptionCheckout(services, context, { priceId: free.id }),
    ).rejects.toMatchObject({
      code: 'unprocessable',
    });
  });
});

describe('server-side verification', () => {
  it('does nothing while the provider still reports the payment as pending', async () => {
    const { payment, organization } = await setup();
    const result = await syncPayment(services, payment.id);
    expect(result).toEqual({ status: 'pending', changed: false, fulfilled: false });
    expect(await subscriptionOf(organization.id)).toBeUndefined();
  });

  it('activates the subscription exactly once, even with concurrent syncs', async () => {
    const { payment, organization, version, checkout, price } = await setup();
    fake.simulate(payment.providerPaymentId!, 'captured');
    const results = await Promise.all([
      syncPayment(services, payment.id),
      syncPayment(services, payment.id),
      syncPayment(services, payment.id),
    ]);
    expect(results.filter((result) => result.fulfilled)).toHaveLength(1);

    const subscription = await subscriptionOf(organization.id);
    expect(subscription).toMatchObject({
      status: 'active',
      planVersionId: version.id,
      provider: 'fake',
    });
    expect(subscription?.currentPeriodEnd).toEqual(
      addInterval(subscription!.currentPeriodStart, 'month'),
    );
    const items = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(subscriptionItems)
        .where(eq(subscriptionItems.organizationId, organization.id)),
    );
    expect(items.map((item) => item.priceId)).toEqual([price.id]);
    const paid = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(billingEvents)
        .where(
          and(
            eq(billingEvents.organizationId, organization.id),
            eq(billingEvents.type, 'subscription.paid'),
          ),
        ),
    );
    expect(paid).toHaveLength(1);
    const [session] = await withSystem(handle.db, (tx) =>
      tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, checkout.checkoutId)),
    );
    expect(session?.status).toBe('completed');
    const resolved = await withTenant(
      handle.db,
      { organizationId: organization.id, userId: null },
      (tx) => resolveEntitlements(tx, organization.id),
    );
    expect(resolved.values['users.max']).toBe(25);
    const events = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.organizationId, organization.id),
            eq(outboxEvents.type, 'payment.succeeded'),
          ),
        ),
    );
    expect(events).toHaveLength(1);
  });

  it('refuses to fulfil when the provider reports a different amount or currency', async () => {
    const { payment, organization } = await setup(15_000n);
    fake.tamperAmount(payment.providerPaymentId!, money(15n, 'BHD'));
    fake.simulate(payment.providerPaymentId!, 'captured');
    const result = await syncPayment(services, payment.id);
    expect(result.fulfilled).toBe(false);
    const [row] = await withSystem(handle.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, payment.id)),
    );
    expect(row).toMatchObject({ status: 'failed', failureCode: 'amount_mismatch' });
    expect(await subscriptionOf(organization.id)).toBeUndefined();

    const second = await setup(15_000n);
    fake.tamperAmount(second.payment.providerPaymentId!, money(15_000n, 'USD'));
    fake.simulate(second.payment.providerPaymentId!, 'captured');
    await syncPayment(services, second.payment.id);
    expect(await subscriptionOf(second.organization.id)).toBeUndefined();
  });

  it('never regresses a captured payment on stale provider responses', async () => {
    const { payment } = await setup();
    fake.simulate(payment.providerPaymentId!, 'captured');
    await syncPayment(services, payment.id);
    fake.simulate(payment.providerPaymentId!, 'pending');
    const result = await syncPayment(services, payment.id);
    expect(result).toMatchObject({ status: 'captured', changed: false });
  });

  it('marks failed payments and their checkout as failed', async () => {
    const { payment, checkout, organization } = await setup();
    fake.simulate(payment.providerPaymentId!, 'failed');
    await syncPayment(services, payment.id);
    const [session] = await withSystem(handle.db, (tx) =>
      tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, checkout.checkoutId)),
    );
    expect(session?.status).toBe('failed');
    expect(await subscriptionOf(organization.id)).toBeUndefined();
  });

  it('extends the period from the current end when renewing early', async () => {
    const first = await setup();
    fake.simulate(first.payment.providerPaymentId!, 'captured');
    await syncPayment(services, first.payment.id);
    const before = await subscriptionOf(first.organization.id);
    const renewal = await createSubscriptionCheckout(
      services,
      {
        organizationId: first.organization.id,
        userId: first.user.id,
        audit: SYSTEM_AUDIT_CONTEXT,
        correlationId: 'r2',
      },
      { priceId: first.price.id },
    );
    const [renewalPayment] = await withSystem(handle.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, renewal.paymentId)),
    );
    fake.simulate(renewalPayment!.providerPaymentId!, 'captured');
    await syncPayment(services, renewal.paymentId);
    const after = await subscriptionOf(first.organization.id);
    expect(after?.currentPeriodStart).toEqual(before?.currentPeriodEnd);
    expect(after?.currentPeriodEnd).toEqual(addInterval(before!.currentPeriodEnd!, 'month'));
  });
});

describe('webhooks', () => {
  it('rejects unsigned or forged webhooks and records the attempt', async () => {
    const { payment, organization } = await setup();
    fake.simulate(payment.providerPaymentId!, 'captured');
    const forged = Buffer.from(
      JSON.stringify({
        id: 'evt_forged',
        payment_id: payment.providerPaymentId,
        status: 'captured',
        reference: payment.id,
      }),
    );
    await expect(
      handlePaymentWebhook(services, 'fake', forged, { 'x-fake-signature': 'ab'.repeat(32) }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(handlePaymentWebhook(services, 'fake', forged, {})).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    // Nothing was fulfilled by the forged notification.
    expect(await subscriptionOf(organization.id)).toBeUndefined();
    const rejected = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, 'fake'),
            eq(paymentWebhookEvents.signatureValid, false),
          ),
        ),
    );
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('treats the webhook status as a hint and verifies with the provider', async () => {
    const { payment, organization } = await setup();
    // Correctly signed, claims captured — but the provider says it is still pending.
    const { body, headers } = fake.signedWebhook({
      id: `evt_${uniqueSuffix()}`,
      payment_id: payment.providerPaymentId!,
      status: 'captured',
      reference: payment.id,
    });
    expect(await handlePaymentWebhook(services, 'fake', Buffer.from(body), headers)).toBe(
      'processed',
    );
    expect(await subscriptionOf(organization.id)).toBeUndefined();
  });

  it('processes each provider event once (replay protection)', async () => {
    const { payment, organization } = await setup();
    fake.simulate(payment.providerPaymentId!, 'captured');
    const event = fake.signedWebhook({
      id: `evt_${uniqueSuffix()}`,
      payment_id: payment.providerPaymentId!,
      status: 'captured',
      reference: payment.id,
    });
    expect(
      await handlePaymentWebhook(services, 'fake', Buffer.from(event.body), event.headers),
    ).toBe('processed');
    expect(
      await handlePaymentWebhook(services, 'fake', Buffer.from(event.body), event.headers),
    ).toBe('duplicate');
    expect((await subscriptionOf(organization.id))?.status).toBe('active');
  });

  it('ignores webhooks for unknown payments and unknown providers', async () => {
    const event = fake.signedWebhook({
      id: `evt_${uniqueSuffix()}`,
      payment_id: 'fake_0000000000000000',
      status: 'captured',
      reference: null,
    });
    expect(
      await handlePaymentWebhook(services, 'fake', Buffer.from(event.body), event.headers),
    ).toBe('ignored');
    await expect(
      handlePaymentWebhook(services, 'stripe', Buffer.from(event.body), event.headers),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('tenant access', () => {
  it('tenants can read but never write payments or checkouts', async () => {
    const { payment, organization } = await setup();
    const updated = await withTenant(
      handle.db,
      { organizationId: organization.id, userId: null },
      (tx) =>
        tx
          .update(payments)
          .set({ status: 'captured' })
          .where(eq(payments.id, payment.id))
          .returning(),
    );
    expect(updated).toEqual([]);
    const visible = await withTenant(
      handle.db,
      { organizationId: organization.id, userId: null },
      (tx) => tx.select().from(payments).where(eq(payments.id, payment.id)),
    );
    expect(visible).toHaveLength(1);
    const other = await setup();
    const foreign = await withTenant(
      handle.db,
      { organizationId: other.organization.id, userId: null },
      (tx) => tx.select().from(payments).where(eq(payments.id, payment.id)),
    );
    expect(foreign).toEqual([]);
  });
});

describe('subscription maintenance', () => {
  it('moves ended paid periods to past_due, then paused after the grace period', async () => {
    const { payment, organization } = await setup();
    fake.simulate(payment.providerPaymentId!, 'captured');
    await syncPayment(services, payment.id);
    const subscription = await subscriptionOf(organization.id);
    const afterEnd = new Date(subscription!.currentPeriodEnd!.getTime() + 60_000);
    await runSubscriptionMaintenance(handle.db, afterEnd);
    expect((await subscriptionOf(organization.id))?.status).toBe('past_due');
    // Still entitled during dunning.
    const during = await withTenant(
      handle.db,
      { organizationId: organization.id, userId: null },
      (tx) => resolveEntitlements(tx, organization.id),
    );
    expect(during.values['users.max']).toBe(25);
    await runSubscriptionMaintenance(
      handle.db,
      new Date(afterEnd.getTime() + 8 * 24 * 3600 * 1000),
    );
    expect((await subscriptionOf(organization.id))?.status).toBe('paused');
    const paused = await withTenant(
      handle.db,
      { organizationId: organization.id, userId: null },
      (tx) => resolveEntitlements(tx, organization.id),
    );
    expect(paused.sources['users.max']).toBe('fallback');
  });

  it('expires stale open checkouts', async () => {
    const { checkout } = await setup();
    await runSubscriptionMaintenance(handle.db, new Date(Date.now() + 2 * 3600 * 1000));
    const [session] = await withSystem(handle.db, (tx) =>
      tx.select().from(checkoutSessions).where(eq(checkoutSessions.id, checkout.checkoutId)),
    );
    expect(session?.status).toBe('expired');
  });
});

describe('addInterval', () => {
  it('clamps to month ends', () => {
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addInterval(new Date('2028-01-31T10:00:00Z'), 'month').toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
    expect(addInterval(new Date('2026-03-15T00:00:00Z'), 'year').toISOString()).toBe(
      '2027-03-15T00:00:00.000Z',
    );
  });
});
