import { commerceProviders } from '@businessos/commerce';
import { outboxEvents, payments, withSystem } from '@businessos/database';
import { FakePaymentProvider } from '@businessos/payments';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();
const logLines: string[] = [];
const fake = new FakePaymentProvider({
  webhookSecret: 'api-commerce-webhook-secret',
  checkoutBaseUrl: 'http://localhost:3000/dev/fake-invoice-checkout',
});

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

const commerce = (orgId: string, path = '') => `/app/orgs/${orgId}/commerce${path}`;

beforeAll(async () => {
  ctx = await createTestContext({
    commerceProviders: commerceProviders({ fake }),
    env: { LOG_LEVEL: 'info' },
    logStream: { write: (line) => logLines.push(line) },
  });
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
  const owner = await as(world.orgA.users.owner);
  const connected = await owner.post(commerce(A, '/payment-connection'), {
    provider: 'fake',
    name: 'Test payments',
  });
  expect(connected.statusCode).toBe(201);
});

afterAll(async () => {
  await ctx.close();
});

async function newContact(client: TestClient, orgId = A) {
  const response = await client.post(`/app/orgs/${orgId}/crm/contacts`, {
    firstName: 'Maryam',
    lastName: `Haddad ${uniqueSuffix()}`,
    email: `maryam.${uniqueSuffix()}@example.com`,
  });
  expect(response.statusCode).toBe(201);
  return response.json().contact as { id: string; email: string };
}

/** A draft BHD invoice (2 × 15.250 + 10% VAT = 33.550) created by the owner of org A. */
async function draftInvoice(client?: TestClient) {
  const owner = client ?? (await as(world.orgA.users.owner));
  const contact = await newContact(await as(world.orgA.users.owner));
  const tax = await (
    await as(world.orgA.users.owner)
  ).post(commerce(A, '/tax-rates'), {
    name: 'VAT',
    percent: '10',
  });
  expect(tax.statusCode).toBe(201);
  const created = await owner.post(commerce(A, '/invoices'), {
    contactId: contact.id,
    currency: 'BHD',
    lines: [
      {
        description: 'Membership',
        quantity: '2',
        unitAmount: '15.250',
        taxRateId: tax.json().taxRate.id,
      },
    ],
  });
  expect(created.statusCode).toBe(201);
  return { invoice: created.json().invoice, contact };
}

describe('commerce API', () => {
  it('computes totals on the server and ignores privileged fields', async () => {
    const owner = await as(world.orgA.users.owner);
    const contact = await newContact(owner);
    const response = await owner.post(commerce(A, '/invoices'), {
      contactId: contact.id,
      lines: [{ description: 'Service', quantity: '1', unitAmount: '5' }],
      totalMinor: '1',
      status: 'paid',
      amountPaidMinor: '5000',
      number: 'INV-999999',
    });
    expect(response.statusCode).toBe(201);
    const { invoice } = response.json();
    expect(invoice).toMatchObject({ status: 'draft', number: null, currency: 'BHD' });
    expect(invoice.total).toEqual({ amountMinor: '5000', amount: '5.000', currency: 'BHD' });
    expect(invoice.amountPaid.amountMinor).toBe('0');
    const invalid = await owner.post(commerce(A, '/invoices'), {
      contactId: contact.id,
      lines: [{ description: 'Service', quantity: '1', unitAmount: '5.0001' }],
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('enforces permissions server-side', async () => {
    const { invoice } = await draftInvoice();
    const sales = await as(world.orgA.users.sales);
    const manager = await as(world.orgA.users.manager);
    const restricted = await as(world.orgA.users.restricted);
    expect((await restricted.get(commerce(A, '/invoices'))).statusCode).toBe(403);
    // Members draft; issuing, voiding and recording payments need commerce.invoice.update.
    expect((await sales.get(commerce(A, `/invoices/${invoice.id}`))).statusCode).toBe(200);
    expect((await sales.post(commerce(A, `/invoices/${invoice.id}/issue`))).statusCode).toBe(403);
    expect((await sales.post(commerce(A, '/products'), { name: 'X' })).statusCode).toBe(403);
    expect((await manager.get(commerce(A, '/payment-connection'))).statusCode).toBe(403);
    expect(
      (await manager.patch(commerce(A, '/settings'), { invoicePrefix: 'X-' })).statusCode,
    ).toBe(403);
    const issued = await manager.post(commerce(A, `/invoices/${invoice.id}/issue`), {
      email: false,
    });
    expect(issued.statusCode).toBe(200);
    const paid = await manager.post(commerce(A, `/invoices/${invoice.id}/payments`), {
      amount: '33.550',
      method: 'cash',
    });
    expect(paid.statusCode).toBe(201);
    const paymentId = paid.json().invoice.payments[0].id;
    // Refunds are owner/admin only.
    expect(
      (
        await manager.post(commerce(A, `/invoices/${invoice.id}/payments/${paymentId}/refund`), {
          amount: '1',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(403);
    const refunded = await (
      await as(world.orgA.users.admin)
    ).post(commerce(A, `/invoices/${invoice.id}/payments/${paymentId}/refund`), {
      amount: '3.550',
      reason: 'Discount after the fact',
    });
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json().invoice).toMatchObject({ status: 'open' });
    expect(refunded.json().invoice.amountDue.amount).toBe('3.550');
  });

  it('returns 404 for another organization and its records', async () => {
    const { invoice } = await draftInvoice();
    const bOwner = await as(world.orgB.users.owner);
    expect((await bOwner.get(commerce(A, '/invoices'))).statusCode).toBe(404);
    for (const [method, path] of [
      ['GET', `/invoices/${invoice.id}`],
      ['PATCH', `/invoices/${invoice.id}`],
      ['DELETE', `/invoices/${invoice.id}`],
      ['POST', `/invoices/${invoice.id}/issue`],
      ['POST', `/invoices/${invoice.id}/void`],
      ['POST', `/invoices/${invoice.id}/payments`],
      ['GET', `/invoices/${invoice.id}/document`],
    ] as const) {
      const response = await bOwner.request(
        method,
        commerce(B, path),
        method === 'GET' || method === 'DELETE'
          ? undefined
          : { notes: 'x', amount: '1', method: 'cash' },
      );
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
    const list = await bOwner.get(commerce(B, '/invoices'));
    expect(list.json().data.some((entry: { id: string }) => entry.id === invoice.id)).toBe(false);
  });

  it('takes a customer from the emailed link through online payment to a paid invoice', async () => {
    const owner = await as(world.orgA.users.owner);
    const { invoice, contact } = await draftInvoice();
    const issued = await owner.post(commerce(A, `/invoices/${invoice.id}/issue`), {});
    expect(issued.statusCode).toBe(200);
    const { link, emailed } = issued.json();
    expect(emailed).toBe(true);
    const token = /\/i\/([A-Za-z0-9_-]{43})$/.exec(link)?.[1] ?? '';
    expect(token).not.toBe('');
    const email = ctx.jobs.ofType('email.send').findLast((job) => job.payload.to === contact.email);
    expect(email?.payload).toMatchObject({ template: 'invoice_sent' });
    expect(email?.payload.data).toMatchObject({ total: 'BHD 33.550', link });

    const view = await ctx.app.inject({ method: 'GET', url: `/public/commerce/invoices/${token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ payable: true, invoice: { status: 'open' } });
    expect(view.json().invoice.amountDue.amount).toBe('33.550');
    expect(JSON.stringify(view.json())).not.toContain(world.orgA.organization.id);

    const checkout = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/invoices/${token}/checkout`,
      payload: {},
    });
    expect(checkout.statusCode).toBe(200);
    const providerPaymentId =
      new URL(checkout.json().redirectUrl).searchParams.get('payment') ?? '';
    // A redirect back proves nothing: still open until verified with the provider.
    const early = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/invoices/${token}/refresh`,
      payload: {},
    });
    expect(early.json().invoice.status).toBe('open');

    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/dev/fake-payments/${providerPaymentId}/complete`,
      payload: { status: 'captured' },
    });
    expect(completed.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/invoices/${token}/refresh`,
      payload: {},
    });
    expect(after.json()).toMatchObject({ payable: false, invoice: { status: 'paid' } });
    const staff = await owner.get(commerce(A, `/invoices/${invoice.id}`));
    expect(staff.json().invoice.payments[0]).toMatchObject({ source: 'online' });

    // The provider's webhook arrives too: verified, recorded once, no second application.
    const { connection } = (await owner.get(commerce(A, '/payment-connection'))).json();
    const signed = fake.signedWebhook({
      id: `evt_${uniqueSuffix()}`,
      payment_id: providerPaymentId,
      status: 'captured',
      reference: null,
    });
    const delivered = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/commerce/${connection.id}`,
      payload: signed.body,
      headers: signed.headers,
    });
    expect(delivered.statusCode).toBe(200);
    expect(['processed', 'duplicate']).toContain(delivered.json().outcome);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/commerce/${connection.id}`,
      payload: signed.body,
      headers: signed.headers,
    });
    expect(replay.json().outcome).toBe('duplicate');
    const forged = await ctx.app.inject({
      method: 'POST',
      url: `/webhooks/commerce/${connection.id}`,
      payload: signed.body,
      headers: { ...signed.headers, 'x-fake-signature': '00'.repeat(32) },
    });
    expect(forged.statusCode).toBe(401);
    const paidEvents = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.type, 'invoice.paid'), eq(outboxEvents.subjectId, invoice.id))),
    );
    expect(paidEvents).toHaveLength(1);
    const [payment] = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(payments).where(eq(payments.providerPaymentId, providerPaymentId)),
    );
    expect(payment).toMatchObject({ purpose: 'invoice', status: 'captured', amountMinor: 33_550n });

    // The customer link token never reaches the logs.
    expect(logLines.join('\n')).not.toContain(token);
    expect(logLines.join('\n')).toContain('/public/commerce/invoices/[REDACTED]');
  });

  it('sends quotes that customers accept, then converts them to invoices', async () => {
    const owner = await as(world.orgA.users.owner);
    const contact = await newContact(owner);
    const created = await owner.post(commerce(A, '/quotes'), {
      contactId: contact.id,
      lines: [{ description: 'Corporate wellness package', quantity: '1', unitAmount: '1250' }],
    });
    expect(created.statusCode).toBe(201);
    const { quote } = created.json();
    const sent = await owner.post(commerce(A, `/quotes/${quote.id}/send`), {});
    expect(sent.json()).toMatchObject({ emailed: true, quote: { status: 'sent' } });
    const token = /\/q\/([A-Za-z0-9_-]{43})$/.exec(sent.json().link)?.[1] ?? '';
    const accepted = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/quotes/${token}/respond`,
      payload: { decision: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().quote).toMatchObject({ status: 'accepted', canRespond: false });
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/public/commerce/quotes/${token}/respond`,
      payload: { decision: 'decline' },
    });
    expect(again.statusCode).toBe(409);
    const converted = await owner.post(commerce(A, `/quotes/${quote.id}/convert`));
    expect(converted.statusCode).toBe(201);
    expect(converted.json().invoice).toMatchObject({ quoteId: quote.id, status: 'draft' });
    expect(converted.json().invoice.total.amount).toBe('1250.000');
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/public/commerce/quotes/${'a'.repeat(43)}`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('never returns stored payment credentials', async () => {
    const bOwner = await as(world.orgB.users.owner);
    const secretKey = `sk_test_${uniqueSuffix().replace(/[^A-Za-z0-9]/g, '')}abcdefgh`;
    const created = await bOwner.post(commerce(B, '/payment-connection'), {
      provider: 'tap',
      name: 'Tap',
      credentials: { secretKey },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secretKey);
    const read = await bOwner.get(commerce(B, '/payment-connection'));
    expect(read.body).not.toContain(secretKey);
    expect(read.json().connection).toMatchObject({
      status: 'active',
      configuredFields: ['secretKey'],
    });
    expect(logLines.join('\n')).not.toContain(secretKey);
    const removed = await bOwner.delete(
      commerce(B, `/payment-connection/${read.json().connection.id}`),
    );
    expect(removed.statusCode).toBe(204);
  });
});
