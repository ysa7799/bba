import { addPrice, createPlan, createPlanVersion, publishPlanVersion } from '@businessos/billing';
import { payments, subscriptions, withSystem } from '@businessos/database';
import { FakePaymentProvider, PaymentProviderRegistry } from '@businessos/payments';
import { createTestUser, createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '../src/env';
import { createTestContext, loginAs, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let fake: FakePaymentProvider;
let priceId: string;

beforeAll(async () => {
  fake = new FakePaymentProvider({
    webhookSecret: 'api-test-webhook-secret',
    checkoutBaseUrl: 'http://localhost:3000/dev/fake-checkout',
  });
  ctx = await createTestContext({
    env: { PAYMENTS_PROVIDER: 'fake' },
    paymentProviders: new PaymentProviderRegistry().register(fake),
  });
  world = await createTestWorld(ctx.db.db);
  priceId = await withSystem(ctx.db.db, async (tx) => {
    const plan = await createPlan(tx, {
      key: `api-pay-${uniqueSuffix()}`,
      name: 'Paid',
      isPublic: true,
      sortOrder: 60,
    });
    const version = await createPlanVersion(tx, plan.id, { 'users.max': 30 });
    const price = await addPrice(tx, version.id, {
      currency: 'BHD',
      interval: 'month',
      amountMinor: 20_000n,
    });
    await publishPlanVersion(tx, version.id);
    return price.id;
  });
});

afterAll(async () => {
  await ctx.close();
});

async function freshOrg() {
  const owner = await createTestUser(ctx.db.db, { name: 'Buyer' });
  const client = await loginAs(ctx, owner);
  const created = await client.post('/app/orgs', { name: `Buyer ${uniqueSuffix()}` });
  return { client, owner, orgId: created.json().organization.id as string };
}

async function providerRef(paymentId: string): Promise<string> {
  const [row] = await withSystem(ctx.db.db, (tx) =>
    tx.select().from(payments).where(eq(payments.id, paymentId)),
  );
  return row!.providerPaymentId!;
}

describe('checkout over HTTP', () => {
  it('exposes payment configuration to signed-in users', async () => {
    const { client } = await freshOrg();
    const response = await client.get('/app/billing/payments-config');
    expect(response.json()).toMatchObject({ provider: 'fake', status: 'ready', methods: ['card'] });
  });

  it('creates a checkout with a server-side price and ignores client amounts', async () => {
    const { client, orgId } = await freshOrg();
    const response = await client.post(`/app/orgs/${orgId}/billing/checkout`, {
      priceId,
      amount: '0.001',
      currency: 'USD',
    });
    expect(response.statusCode).toBe(201);
    const { paymentId, redirectUrl } = response.json<{
      paymentId: string;
      redirectUrl: string;
    }>();
    expect(redirectUrl).toContain('/dev/fake-checkout?payment=fake_');
    const [row] = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, paymentId)),
    );
    expect(row).toMatchObject({ amountMinor: 20_000n, currency: 'BHD', organizationId: orgId });
  });

  it('requires settings.billing.manage and is tenant isolated', async () => {
    const restricted = await loginAs(ctx, world.orgA.users.restricted);
    expect(
      (
        await restricted.post(`/app/orgs/${world.orgA.organization.id}/billing/checkout`, {
          priceId,
        })
      ).statusCode,
    ).toBe(403);
    const { client, orgId } = await freshOrg();
    const created = await client.post(`/app/orgs/${orgId}/billing/checkout`, { priceId });
    const checkoutId = created.json().checkoutId as string;
    const outsider = await loginAs(ctx, world.orgB.users.owner);
    expect(
      (await outsider.get(`/app/orgs/${orgId}/billing/checkout/${checkoutId}`)).statusCode,
    ).toBe(404);
    const otherOrg = world.orgB.organization.id;
    expect(
      (await outsider.get(`/app/orgs/${otherOrg}/billing/checkout/${checkoutId}`)).statusCode,
    ).toBe(404);
    expect(
      (await outsider.post(`/app/orgs/${otherOrg}/billing/checkout/${checkoutId}/verify`))
        .statusCode,
    ).toBe(404);
  });
});

describe('payment state cannot be forged from the client', () => {
  it('ignores "success" hints on the return/verify path until the provider confirms', async () => {
    const { client, orgId } = await freshOrg();
    const created = await client.post(`/app/orgs/${orgId}/billing/checkout`, { priceId });
    const { checkoutId, paymentId } = created.json<{ checkoutId: string; paymentId: string }>();

    const forged = await client.post(
      `/app/orgs/${orgId}/billing/checkout/${checkoutId}/verify?tap_id=chg_fake&status=CAPTURED`,
      { status: 'captured', providerPaymentId: 'fake_0000000000000000' },
    );
    expect(forged.statusCode).toBe(200);
    expect(forged.json()).toMatchObject({
      checkout: { status: 'open' },
      payment: { status: 'pending' },
    });
    const [subscription] = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId)),
    );
    expect(subscription?.provider ?? 'manual').toBe('manual');

    fake.simulate(await providerRef(paymentId), 'captured');
    const verified = await client.post(`/app/orgs/${orgId}/billing/checkout/${checkoutId}/verify`);
    expect(verified.json()).toMatchObject({
      checkout: { status: 'completed' },
      payment: { status: 'captured' },
    });
    const entitlements = await client.get(`/app/orgs/${orgId}/billing/entitlements`);
    expect(entitlements.json().entitlements['users.max']).toBe(30);
  });

  it('has no client endpoint to set payment status', async () => {
    const { client, orgId } = await freshOrg();
    const created = await client.post(`/app/orgs/${orgId}/billing/checkout`, { priceId });
    const { checkoutId } = created.json<{ checkoutId: string }>();
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      expect(
        (
          await client.request(method, `/app/orgs/${orgId}/billing/checkout/${checkoutId}`, {
            status: 'completed',
          })
        ).statusCode,
      ).toBe(404);
    }
  });
});

describe('webhook endpoint', () => {
  it('verifies signatures over the raw body', async () => {
    const { client, orgId } = await freshOrg();
    const created = await client.post(`/app/orgs/${orgId}/billing/checkout`, { priceId });
    const { paymentId } = created.json<{ paymentId: string }>();
    const ref = await providerRef(paymentId);
    fake.simulate(ref, 'captured');
    const event = fake.signedWebhook({
      id: `evt_${uniqueSuffix()}`,
      payment_id: ref,
      status: 'captured',
      reference: paymentId,
    });

    const tampered = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      headers: event.headers,
      payload: event.body.replace('captured', 'refunded'),
    });
    expect(tampered.statusCode).toBe(401);

    // Whitespace changes the raw bytes: signatures must be checked before any re-serialization.
    const reformatted = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      headers: event.headers,
      payload: JSON.stringify(JSON.parse(event.body), null, 2),
    });
    expect(reformatted.statusCode).toBe(401);

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      headers: event.headers,
      payload: event.body,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ received: true, outcome: 'processed' });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments/fake',
      headers: event.headers,
      payload: event.body,
    });
    expect(replay.json()).toEqual({ received: true, outcome: 'duplicate' });

    const status = await client.get(`/app/orgs/${orgId}/billing/payments`);
    expect(status.json().data[0]).toMatchObject({
      status: 'captured',
      amount: { amount: '20.000', currency: 'BHD' },
    });
  });

  it('does not require cookies or origin headers, and rejects unknown providers', async () => {
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments/paypal',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('development fake checkout route', () => {
  it('only lets the user who started a payment complete it', async () => {
    const { client, orgId } = await freshOrg();
    const created = await client.post(`/app/orgs/${orgId}/billing/checkout`, { priceId });
    const ref = await providerRef(created.json().paymentId as string);
    const stranger = await loginAs(ctx, world.orgB.users.owner);
    expect(
      (await stranger.post(`/app/dev/payments/fake/${ref}/complete`, { status: 'captured' }))
        .statusCode,
    ).toBe(404);
    const done = await client.post(`/app/dev/payments/fake/${ref}/complete`, {
      status: 'captured',
    });
    expect(done.json()).toEqual({ status: 'captured', organizationId: orgId });
  });
});

describe('payment configuration safety', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379/0',
    APP_URL: 'https://app.example.com',
    CORS_ORIGINS: 'https://app.example.com',
    API_PUBLIC_URL: 'https://api.example.com',
  };

  it('refuses the fake provider and a keyless Tap setup in production', () => {
    expect(() => loadApiEnv({ ...base, PAYMENTS_PROVIDER: 'fake' })).toThrow(
      /fake payment provider/,
    );
    expect(() => loadApiEnv({ ...base, PAYMENTS_PROVIDER: 'tap' })).toThrow(/TAP_SECRET_KEY/);
    expect(() =>
      loadApiEnv({ ...base, PAYMENTS_PROVIDER: 'tap', TAP_SECRET_KEY: 'sk_live_abcdefghijkl' }),
    ).not.toThrow();
  });
});
