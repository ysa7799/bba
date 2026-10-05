import { projectEvent } from '@businessos/activities';
import { createContact, type CrmContext } from '@businessos/crm';
import {
  activities,
  commerceInvoicePayments,
  commerceInvoices,
  commercePaymentConnections,
  commerceQuotes,
  outboxEvents,
  paymentWebhookEvents,
  payments,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { createOrganization } from '@businessos/organizations';
import { FakePaymentProvider } from '@businessos/payments';
import {
  ConflictError,
  NotFoundError,
  SecretBox,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '@businessos/shared';
import {
  createTestDatabase,
  createTestUser,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commerceProviders,
  commerceTimelineProjectors,
  convertQuoteToInvoice,
  createInvoice,
  createPaymentConnection,
  createProduct,
  createQuote,
  createTaxRate,
  deleteDraftInvoice,
  disconnectPaymentConnection,
  expireQuotes,
  getInvoice,
  getQuote,
  handleCommerceWebhook,
  issueInvoice,
  listInvoices,
  listProducts,
  markOverdueInvoices,
  providerForConnection,
  recordManualPayment,
  refreshPublicInvoicePayments,
  refundInvoicePayment,
  renewInvoiceLink,
  resolvePublicInvoice,
  resolvePublicQuote,
  respondToPublicQuote,
  sendQuote,
  startInvoiceCheckout,
  syncInvoicePayment,
  updateInvoice,
  updateProduct,
  updateSettings,
  voidInvoice,
  type CommerceServices,
  type InvoiceDetail,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
let orgC: Organization;
let cOwner: string;

const fake = new FakePaymentProvider({
  webhookSecret: 'commerce-test-webhook-secret',
  checkoutBaseUrl: 'http://localhost:3000/pay/fake',
});
let services: CommerceServices;
const audit = {
  actorType: 'user' as const,
  actorUserId: null,
  actorLabel: 'test',
  ipAddress: null,
  userAgent: null,
  requestId: null,
};

beforeAll(async () => {
  handle = createTestDatabase(10);
  world = await createTestWorld(handle.db);
  const owner = await createTestUser(handle.db, { name: `C Owner ${uniqueSuffix()}` });
  cOwner = owner.id;
  ({ organization: orgC } = await createOrganization(handle.db, owner.id, {
    name: `Org C ${uniqueSuffix()}`,
  }));
  services = {
    db: handle.db,
    providers: commerceProviders({ fake }),
    secretBox: new SecretBox([{ id: 'test', key: randomBytes(32) }]),
    apiPublicUrl: 'http://localhost:4000',
    appUrl: 'http://localhost:3000',
  };
  // Org A takes payments through the fake provider; org B too (isolation of webhooks).
  await inOrg(A(), aOwner(), (tx, ctx) =>
    createPaymentConnection(tx, ctx, services, { provider: 'fake', name: 'Test payments' }),
  );
  await inOrg(B(), bOwner(), (tx, ctx) =>
    createPaymentConnection(tx, ctx, services, { provider: 'fake', name: 'Test payments' }),
  );
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;
const aOwner = () => world.orgA.users.owner.id;
const bOwner = () => world.orgB.users.owner.id;

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(
  org: Organization,
  userId: string | null,
  fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
) {
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, ctxFor(org, userId)),
  );
}

async function rejects<E>(promise: Promise<unknown>, type: abstract new (...args: never[]) => E) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

async function contact(org: Organization = A(), owner: string = aOwner()) {
  return inOrg(org, owner, (tx, ctx) =>
    createContact(tx, ctx, {
      firstName: 'Fatima',
      lastName: `Al Khalifa ${uniqueSuffix()}`,
      email: `fatima.${uniqueSuffix()}@example.com`,
    }),
  );
}

/** An issued BHD invoice for 3 × 12.345 with 10% discount and 10% VAT (total 36.664). */
async function issuedInvoice(
  org: Organization = A(),
  owner: string = aOwner(),
): Promise<{ invoice: InvoiceDetail; token: string }> {
  const customer = await contact(org, owner);
  return inOrg(org, owner, async (tx, ctx) => {
    const vat = await createTaxRate(tx, ctx, { name: 'VAT', percent: '10' });
    const draft = await createInvoice(tx, ctx, {
      contactId: customer.id,
      currency: 'BHD',
      lines: [
        {
          description: 'Personal training session',
          quantity: '3',
          unitAmount: '12.345',
          discountPercent: '10',
          taxRateId: vat.id,
        },
      ],
    });
    return issueInvoice(tx, ctx, draft.id);
  });
}

function outbox(org: Organization, type: string) {
  return withSystem(handle.db, (tx) =>
    tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.organizationId, org.id), eq(outboxEvents.type, type))),
  );
}

function providerPaymentIdOf(paymentId: string) {
  return withSystem(handle.db, async (tx) => {
    const [row] = await tx.select().from(payments).where(eq(payments.id, paymentId));
    return row?.providerPaymentId ?? '';
  });
}

async function connectionOf(org: Organization) {
  return withSystem(handle.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(commercePaymentConnections)
      .where(
        and(
          eq(commercePaymentConnections.organizationId, org.id),
          eq(commercePaymentConnections.status, 'active'),
        ),
      );
    if (!row) throw new Error('no connection');
    return row;
  });
}

function webhook(connectionId: string, event: Parameters<FakePaymentProvider['signedWebhook']>[0]) {
  const signed = fake.signedWebhook(event);
  return handleCommerceWebhook(services, connectionId, Buffer.from(signed.body), signed.headers);
}

describe('catalogue', () => {
  it('stores prices per currency in minor units and archives replaced prices', async () => {
    const product = await inOrg(A(), aOwner(), (tx, ctx) =>
      createProduct(tx, ctx, {
        name: `Monthly membership ${uniqueSuffix()}`,
        sku: `MEM-${uniqueSuffix()}`,
        prices: [
          { currency: 'BHD', amount: '35.500' },
          { currency: 'SAR', amount: '350' },
        ],
      }),
    );
    expect(product.prices.map((price) => [price.currency, price.unitAmount.amountMinor])).toEqual(
      expect.arrayContaining([
        ['BHD', '35500'],
        ['SAR', '35000'],
      ]),
    );
    const updated = await inOrg(A(), aOwner(), (tx, ctx) =>
      updateProduct(tx, ctx, product.id, { prices: [{ currency: 'BHD', amount: '40' }] }),
    );
    expect(updated.prices.map((price) => [price.currency, price.unitAmount.amountMinor])).toEqual([
      ['BHD', '40000'],
    ]);
    // Too many decimals for the currency is refused, never rounded.
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) =>
        createProduct(tx, ctx, { name: 'Bad', prices: [{ currency: 'BHD', amount: '1.2345' }] }),
      ),
      ValidationError,
    );
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) =>
        createProduct(tx, ctx, { name: 'Dup SKU', sku: product.sku?.toLowerCase() ?? '' }),
      ),
      ConflictError,
    );
  });

  it('prices invoice lines from the product price in the invoice currency', async () => {
    const customer = await contact();
    const product = await inOrg(A(), aOwner(), (tx, ctx) =>
      createProduct(tx, ctx, {
        name: `Class pack ${uniqueSuffix()}`,
        prices: [{ currency: 'BHD', amount: '12.500' }],
      }),
    );
    const invoice = await inOrg(A(), aOwner(), (tx, ctx) =>
      createInvoice(tx, ctx, {
        contactId: customer.id,
        currency: 'BHD',
        lines: [{ productId: product.id, description: 'Class pack', quantity: '1.5' }],
      }),
    );
    expect(invoice.total).toEqual({ amountMinor: '18750', amount: '18.750', currency: 'BHD' });
    // No SAR price: the line cannot be priced silently in another currency.
    const error = await rejects(
      inOrg(A(), aOwner(), (tx, ctx) =>
        createInvoice(tx, ctx, {
          contactId: customer.id,
          currency: 'SAR',
          lines: [{ productId: product.id, description: 'Class pack', quantity: '1' }],
        }),
      ),
      ValidationError,
    );
    expect(error.details?.[0]?.path).toBe('lines.0.unitAmount');
  });
});

describe('invoices', () => {
  it('computes every amount on the server and ignores client-sent totals and status', async () => {
    const customer = await contact();
    const invoice = await inOrg(A(), aOwner(), (tx, ctx) =>
      createInvoice(tx, ctx, {
        contactId: customer.id,
        currency: 'BHD',
        lines: [{ description: 'Consultation', quantity: '2', unitAmount: '7.250' }],
        // Privileged fields a client might try to send.
        ...({ totalMinor: '1', status: 'paid', amountPaidMinor: '14500' } as object),
      }),
    );
    expect(invoice.status).toBe('draft');
    expect(invoice.total.amountMinor).toBe('14500');
    expect(invoice.amountPaid.amountMinor).toBe('0');
    expect(invoice.number).toBeNull();
  });

  it('issues gapless numbers, also under concurrency, and only drafts are editable', async () => {
    const org = orgC;
    const customer = await contact(org, cOwner);
    await inOrg(org, cOwner, (tx, ctx) => updateSettings(tx, ctx, { invoicePrefix: 'C-' }));
    const drafts = await Promise.all(
      [1, 2, 3, 4].map(() =>
        inOrg(org, cOwner, (tx, ctx) =>
          createInvoice(tx, ctx, {
            contactId: customer.id,
            lines: [{ description: 'Service', quantity: '1', unitAmount: '10' }],
          }),
        ),
      ),
    );
    // A failed issue (rolled back) gives its number back.
    await rejects(
      inOrg(org, cOwner, async (tx, ctx) => {
        await issueInvoice(tx, ctx, drafts[0]?.id ?? '');
        throw new ConflictError('rollback');
      }),
      ConflictError,
    );
    const issued = await Promise.all(
      drafts.map((draft) => inOrg(org, cOwner, (tx, ctx) => issueInvoice(tx, ctx, draft.id))),
    );
    expect(issued.map((entry) => entry.invoice.number).sort()).toEqual([
      'C-000001',
      'C-000002',
      'C-000003',
      'C-000004',
    ]);
    const first = issued[0]?.invoice;
    expect(first?.status).toBe('open');
    expect(first?.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first?.dueDate).not.toBeNull();
    await rejects(
      inOrg(org, cOwner, (tx, ctx) =>
        updateInvoice(tx, ctx, first?.id ?? '', { notes: 'changed' }),
      ),
      ConflictError,
    );
    await rejects(
      inOrg(org, cOwner, (tx, ctx) => deleteDraftInvoice(tx, ctx, first?.id ?? '')),
      ConflictError,
    );
    await rejects(
      inOrg(org, cOwner, (tx, ctx) => issueInvoice(tx, ctx, first?.id ?? '')),
      ConflictError,
    );
    // Numbers only move forward.
    await rejects(
      inOrg(org, cOwner, (tx, ctx) => updateSettings(tx, ctx, { nextInvoiceNumber: 2 })),
      ValidationError,
    );
  });

  it('shows issued invoices to the customer by link only, and a renewed link replaces the old', async () => {
    const { invoice, token } = await issuedInvoice();
    const view = await resolvePublicInvoice(handle.db, token);
    expect(view?.invoice.number).toBe(invoice.number);
    expect(view?.invoice.total.amount).toBe('36.664');
    expect(view?.invoice.amountDue.amount).toBe('36.664');
    expect(await resolvePublicInvoice(handle.db, 'x'.repeat(43))).toBeNull();
    const renewed = await inOrg(A(), aOwner(), (tx, ctx) => renewInvoiceLink(tx, ctx, invoice.id));
    expect(await resolvePublicInvoice(handle.db, token)).toBeNull();
    expect((await resolvePublicInvoice(handle.db, renewed.token))?.invoiceId).toBe(invoice.id);
    // Voided invoices are no longer shown.
    await inOrg(A(), aOwner(), (tx, ctx) => voidInvoice(tx, ctx, invoice.id));
    expect(await resolvePublicInvoice(handle.db, renewed.token)).toBeNull();
    expect(await outbox(A(), 'invoice.voided')).toEqual(
      expect.arrayContaining([expect.objectContaining({ subjectId: invoice.id })]),
    );
  });

  it('marks invoices overdue once, in the organization time zone', async () => {
    const { invoice } = await issuedInvoice();
    await withSystem(handle.db, (tx) =>
      tx
        .update(commerceInvoices)
        .set({ dueDate: '2020-01-01' })
        .where(eq(commerceInvoices.id, invoice.id)),
    );
    await markOverdueInvoices(handle.db);
    await markOverdueInvoices(handle.db);
    const events = (await outbox(A(), 'invoice.overdue')).filter(
      (event) => event.subjectId === invoice.id,
    );
    expect(events).toHaveLength(1);
    const listed = await inOrg(A(), aOwner(), (tx, ctx) =>
      listInvoices(tx, ctx, { status: 'overdue' }),
    );
    expect(listed.data.map((entry) => entry.id)).toContain(invoice.id);
  });
});

describe('quotes', () => {
  it('flows from quote to customer acceptance to invoice with the agreed amounts', async () => {
    const customer = await contact();
    const quote = await inOrg(A(), aOwner(), async (tx, ctx) => {
      const vat = await createTaxRate(tx, ctx, { name: 'VAT', percent: '10' });
      return createQuote(tx, ctx, {
        contactId: customer.id,
        currency: 'BHD',
        lines: [
          { description: 'Annual plan', quantity: '1', unitAmount: '420', taxRateId: vat.id },
        ],
      });
    });
    expect(quote.number).toMatch(/^QUO-\d{6}$/);
    expect(quote.total.amount).toBe('462.000');
    const { token } = await inOrg(A(), aOwner(), (tx, ctx) => sendQuote(tx, ctx, quote.id));
    const seen = await resolvePublicQuote(handle.db, token);
    expect(seen?.quote.canRespond).toBe(true);
    const accepted = await respondToPublicQuote(handle.db, token, { decision: 'accept' });
    expect(accepted.quote.status).toBe('accepted');
    // A second answer is refused.
    await rejects(respondToPublicQuote(handle.db, token, { decision: 'decline' }), ConflictError);

    const invoice = await inOrg(A(), aOwner(), (tx, ctx) =>
      convertQuoteToInvoice(tx, ctx, quote.id),
    );
    expect(invoice.status).toBe('draft');
    expect(invoice.quoteId).toBe(quote.id);
    expect(invoice.total.amountMinor).toBe('462000');
    expect(invoice.lines[0]?.tax?.percent).toBe('10');
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => convertQuoteToInvoice(tx, ctx, quote.id)),
      ConflictError,
    );
    const converted = await inOrg(A(), aOwner(), (tx, ctx) => getQuote(tx, ctx, quote.id));
    expect(converted.status).toBe('converted');
    expect(converted.convertedInvoiceId).toBe(invoice.id);
    const created = await outbox(A(), 'invoice.created');
    expect(created.some((event) => event.subjectId === invoice.id)).toBe(true);

    // The timeline shows the acceptance on the contact.
    const [acceptedEvent] = (await outbox(A(), 'quote.accepted')).filter(
      (event) => event.subjectId === quote.id,
    );
    const loaded = acceptedEvent ? await loadEvent(handle.db, acceptedEvent.id) : null;
    if (!loaded) throw new Error('missing event');
    await projectEvent(handle.db, commerceTimelineProjectors, loaded);
    const [activity] = await withSystem(handle.db, (tx) =>
      tx.select().from(activities).where(eq(activities.sourceEventId, loaded.id)),
    );
    expect(activity?.contactId).toBe(customer.id);
    expect(activity?.summary).toContain(quote.number);
  });

  it('expires sent quotes past their validity', async () => {
    const customer = await contact();
    const quote = await inOrg(A(), aOwner(), async (tx, ctx) => {
      const created = await createQuote(tx, ctx, {
        contactId: customer.id,
        lines: [{ description: 'Item', quantity: '1', unitAmount: '5' }],
      });
      return (await sendQuote(tx, ctx, created.id)).quote;
    });
    await withSystem(handle.db, (tx) =>
      tx
        .update(commerceQuotes)
        .set({ validUntil: '2020-01-01' })
        .where(eq(commerceQuotes.id, quote.id)),
    );
    await expireQuotes(handle.db);
    const after = await inOrg(A(), aOwner(), (tx, ctx) => getQuote(tx, ctx, quote.id));
    expect(after.status).toBe('expired');
  });
});

describe('payment integrity', () => {
  it('applies a verified online payment once, whatever arrives twice or concurrently', async () => {
    const { invoice, token } = await issuedInvoice();
    const checkout = await startInvoiceCheckout(services, token);
    // A second click within the window reuses the same checkout (no duplicate charge).
    expect((await startInvoiceCheckout(services, token)).paymentId).toBe(checkout.paymentId);
    const providerPaymentId = await providerPaymentIdOf(checkout.paymentId);
    expect(checkout.redirectUrl).toContain(providerPaymentId);

    // The customer comes back before paying: nothing changes.
    await refreshPublicInvoicePayments(services, token);
    expect((await resolvePublicInvoice(handle.db, token))?.invoice.status).toBe('open');

    fake.simulate(providerPaymentId, 'captured');
    const connection = await connectionOf(A());
    const event = {
      id: `evt_${uniqueSuffix()}`,
      payment_id: providerPaymentId,
      status: 'captured' as const,
      reference: checkout.paymentId,
    };
    const results = await Promise.all([
      webhook(connection.id, event),
      webhook(connection.id, event),
      syncInvoicePayment(services, checkout.paymentId),
      refreshPublicInvoicePayments(services, token),
    ]);
    expect(results.slice(0, 2).sort()).toEqual(['duplicate', 'processed']);
    const applied = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(commerceInvoicePayments)
        .where(eq(commerceInvoicePayments.invoiceId, invoice.id)),
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.amountMinor).toBe(36_664n);
    const paid = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(paid.status).toBe('paid');
    expect(paid.amountDue.amountMinor).toBe('0');
    expect(paid.payments[0]?.source).toBe('online');
    expect(
      (await outbox(A(), 'invoice.paid')).filter((entry) => entry.subjectId === invoice.id),
    ).toHaveLength(1);
    // Paid: no new checkout.
    await rejects(startInvoiceCheckout(services, token), ConflictError);
    // A replayed webhook is a no-op.
    expect(await webhook(connection.id, event)).toBe('duplicate');
  });

  it('never trusts the redirect or the webhook status, only the provider API', async () => {
    const { invoice, token } = await issuedInvoice();
    const checkout = await startInvoiceCheckout(services, token);
    const providerPaymentId = await providerPaymentIdOf(checkout.paymentId);
    const connection = await connectionOf(A());
    // The webhook claims "captured" but the provider says the payment is still pending.
    expect(
      await webhook(connection.id, {
        id: `evt_${uniqueSuffix()}`,
        payment_id: providerPaymentId,
        status: 'captured',
        reference: checkout.paymentId,
      }),
    ).toBe('processed');
    const still = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(still.status).toBe('open');
    expect(still.attempts[0]?.status).toBe('pending');
  });

  it('refuses a payment whose amount or currency differs from what was requested', async () => {
    const { invoice, token } = await issuedInvoice();
    const checkout = await startInvoiceCheckout(services, token);
    const providerPaymentId = await providerPaymentIdOf(checkout.paymentId);
    fake.tamperAmount(providerPaymentId, { amountMinor: 1_000n, currency: 'BHD' });
    fake.simulate(providerPaymentId, 'captured');
    const result = await syncInvoicePayment(services, checkout.paymentId);
    expect(result).toMatchObject({ status: 'failed', applied: false });
    const after = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(after.status).toBe('open');
    expect(after.amountPaid.amountMinor).toBe('0');
    const [row] = await withSystem(handle.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, checkout.paymentId)),
    );
    expect(row?.failureCode).toBe('amount_mismatch');
  });

  it('supports partial payments: manual first, then online for exactly the remainder', async () => {
    const { invoice, token } = await issuedInvoice();
    const partial = await inOrg(A(), aOwner(), (tx, ctx) =>
      recordManualPayment(tx, ctx, invoice.id, {
        amount: '20.000',
        method: 'cash',
        reference: 'Receipt 12',
      }),
    );
    expect(partial.invoice.status).toBe('open');
    expect(partial.invoice.amountDue.amount).toBe('16.664');
    // No manual overpayment, no zero, no foreign precision.
    for (const amount of ['16.665', '0', '1.0001']) {
      await rejects(
        inOrg(A(), aOwner(), (tx, ctx) =>
          recordManualPayment(tx, ctx, invoice.id, { amount, method: 'cash' }),
        ),
        ValidationError,
      );
    }
    const checkout = await startInvoiceCheckout(services, token);
    const [payment] = await withSystem(handle.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, checkout.paymentId)),
    );
    expect(payment?.amountMinor).toBe(16_664n);
    expect(payment?.currency).toBe('BHD');
    expect(payment?.purpose).toBe('invoice');
    fake.simulate(payment?.providerPaymentId ?? '', 'captured');
    await syncInvoicePayment(services, checkout.paymentId);
    const paid = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(paid.status).toBe('paid');
    expect(paid.amountPaid.amount).toBe('36.664');
    expect(paid.payments.map((entry) => entry.amount.amount)).toEqual(['20.000', '16.664']);
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) =>
        recordManualPayment(tx, ctx, invoice.id, { amount: '1', method: 'cash' }),
      ),
      ConflictError,
    );
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => voidInvoice(tx, ctx, invoice.id)),
      ConflictError,
    );
  });

  it('records a late second online payment as an overpayment instead of losing it', async () => {
    const { invoice, token } = await issuedInvoice();
    const first = await startInvoiceCheckout(services, token, { method: 'card' });
    const second = await startInvoiceCheckout(services, token, { method: 'card' });
    expect(second.paymentId).not.toBe(first.paymentId);
    for (const checkout of [first, second]) {
      fake.simulate(await providerPaymentIdOf(checkout.paymentId), 'captured');
      await syncInvoicePayment(services, checkout.paymentId);
    }
    const after = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(after.status).toBe('paid');
    expect(after.amountOverpaid.amount).toBe('36.664');
    expect(
      (await outbox(A(), 'invoice.paid')).filter((entry) => entry.subjectId === invoice.id),
    ).toHaveLength(1);
  });

  it('bounds refunds by what remains, including concurrent refunds, and reopens the invoice', async () => {
    const { invoice, token } = await issuedInvoice();
    const checkout = await startInvoiceCheckout(services, token);
    fake.simulate(await providerPaymentIdOf(checkout.paymentId), 'captured');
    await syncInvoicePayment(services, checkout.paymentId);
    const paid = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    const appliedId = paid.payments[0]?.id ?? '';
    const ctx = ctxFor(A(), aOwner());

    await rejects(
      refundInvoicePayment(services, ctx, audit, invoice.id, appliedId, {
        amount: '36.665',
        reason: 'Too much',
      }),
      ValidationError,
    );
    const outcomes = await Promise.allSettled([
      refundInvoicePayment(services, ctx, audit, invoice.id, appliedId, {
        amount: '20',
        reason: 'Cancelled',
      }),
      refundInvoicePayment(services, ctx, audit, invoice.id, appliedId, {
        amount: '20',
        reason: 'Cancelled',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(
      ValidationError,
    );

    const after = await inOrg(A(), aOwner(), (tx, c) => getInvoice(tx, c, invoice.id));
    expect(after.status).toBe('open');
    expect(after.amountPaid.amount).toBe('16.664');
    expect(after.amountDue.amount).toBe('20.000');
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]?.status).toBe('succeeded');
    const [payment] = await withSystem(handle.db, (tx) =>
      tx.select().from(payments).where(eq(payments.id, checkout.paymentId)),
    );
    expect(payment?.status).toBe('partially_refunded');
    expect(payment?.refundedAmountMinor).toBe(20_000n);

    // Refund the rest; the invoice can then be voided.
    await refundInvoicePayment(services, ctx, audit, invoice.id, appliedId, {
      amount: '16.664',
      reason: 'Cancelled',
    });
    await rejects(
      refundInvoicePayment(services, ctx, audit, invoice.id, appliedId, {
        amount: '0.001',
        reason: 'More',
      }),
      ValidationError,
    );
    const voided = await inOrg(A(), aOwner(), (tx, c) => voidInvoice(tx, c, invoice.id));
    expect(voided.status).toBe('void');
  });

  it('refunds manual payments as records only', async () => {
    const { invoice } = await issuedInvoice();
    const { invoice: paid } = await inOrg(A(), aOwner(), (tx, ctx) =>
      recordManualPayment(tx, ctx, invoice.id, { amount: '36.664', method: 'bank_transfer' }),
    );
    expect(paid.status).toBe('paid');
    const after = await refundInvoicePayment(
      services,
      ctxFor(A(), aOwner()),
      audit,
      invoice.id,
      paid.payments[0]?.id ?? '',
      {
        amount: '6.664',
        reason: 'Goodwill',
      },
    );
    expect(after.status).toBe('open');
    expect(after.amountDue.amount).toBe('6.664');
  });

  it('rejects unsigned or forged webhooks and unknown endpoints', async () => {
    const connection = await connectionOf(A());
    await rejects(
      handleCommerceWebhook(services, connection.id, Buffer.from('{"id":"x"}'), {
        'x-fake-signature': 'bad',
      }),
      UnauthenticatedError,
    );
    await rejects(
      handleCommerceWebhook(services, 'not-a-uuid', Buffer.from('{}'), {}),
      NotFoundError,
    );
    const rejected = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, `commerce:${connection.id}`),
            eq(paymentWebhookEvents.status, 'rejected'),
          ),
        ),
    );
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('does not offer online payment without an active connection', async () => {
    const customer = await contact(orgC, cOwner);
    const { token } = await inOrg(orgC, cOwner, async (tx, ctx) => {
      const draft = await createInvoice(tx, ctx, {
        contactId: customer.id,
        lines: [{ description: 'Service', quantity: '1', unitAmount: '10' }],
      });
      return issueInvoice(tx, ctx, draft.id);
    });
    await rejects(startInvoiceCheckout(services, token), UnprocessableError);
    // Tap without a secret key is CONFIGURATION_REQUIRED.
    const tap = await inOrg(orgC, cOwner, (tx, ctx) =>
      createPaymentConnection(tx, ctx, services, { provider: 'tap', name: 'Tap' }),
    );
    expect(tap.status).toBe('configuration_required');
    await rejects(startInvoiceCheckout(services, token), UnprocessableError);
    await inOrg(orgC, cOwner, (tx, ctx) => disconnectPaymentConnection(tx, ctx, tap.id));

    // Credentials are sealed and never returned.
    const secretKey = `sk_test_${randomBytes(12).toString('hex')}`;
    const live = await inOrg(orgC, cOwner, (tx, ctx) =>
      createPaymentConnection(tx, ctx, services, {
        provider: 'tap',
        name: 'Tap',
        credentials: { secretKey },
      }),
    );
    expect(live.status).toBe('active');
    expect(live.configuredFields).toEqual(['secretKey']);
    expect(JSON.stringify(live)).not.toContain(secretKey);
    const [row] = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(commercePaymentConnections)
        .where(eq(commercePaymentConnections.id, live.id)),
    );
    expect(row?.credentialsCiphertext).toBeTruthy();
    expect(row?.credentialsCiphertext).not.toContain(secretKey);
    expect(row && providerForConnection(services, row)?.name).toBe('tap');
    // A ciphertext moved to another connection does not decrypt.
    if (!row) throw new Error('missing row');
    expect(providerForConnection(services, { ...row, id: tap.id })).toBeNull();
    await rejects(
      inOrg(orgC, cOwner, (tx, ctx) =>
        createPaymentConnection(tx, ctx, services, {
          provider: 'tap',
          name: 'Bad',
          credentials: { secretKey: 'nope' },
        }),
      ),
      ValidationError,
    );
  });
});

describe('tenant isolation', () => {
  it('keeps invoices, quotes, products and payments inside their organization', async () => {
    const { invoice, token } = await issuedInvoice();
    const quote = await inOrg(A(), aOwner(), async (tx, ctx) =>
      createQuote(tx, ctx, {
        contactId: invoice.contact?.id ?? '',
        lines: [{ description: 'Item', quantity: '1', unitAmount: '1' }],
      }),
    );
    const product = (await inOrg(A(), aOwner(), (tx, ctx) => listProducts(tx, ctx.organizationId)))
      .data[0];
    const bCustomer = await contact(B(), bOwner());

    const asB = <T>(fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>) => inOrg(B(), bOwner(), fn);
    await rejects(
      asB((tx, ctx) => getInvoice(tx, ctx, invoice.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => getQuote(tx, ctx, quote.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => updateInvoice(tx, ctx, invoice.id, { notes: 'x' })),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => voidInvoice(tx, ctx, invoice.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => issueInvoice(tx, ctx, invoice.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => convertQuoteToInvoice(tx, ctx, quote.id)),
      NotFoundError,
    );
    await rejects(
      asB((tx, ctx) => recordManualPayment(tx, ctx, invoice.id, { amount: '1', method: 'cash' })),
      NotFoundError,
    );
    await rejects(
      refundInvoicePayment(services, ctxFor(B(), bOwner()), audit, invoice.id, invoice.id, {
        amount: '1',
        reason: 'x',
      }),
      NotFoundError,
    );
    const listed = await asB((tx, ctx) => listInvoices(tx, ctx, {}));
    expect(listed.data.some((entry) => entry.id === invoice.id)).toBe(false);
    const products = await asB((tx, ctx) => listProducts(tx, ctx.organizationId));
    expect(products.data.some((entry) => entry.id === product?.id)).toBe(false);

    // Foreign references are refused as unknown.
    const foreignProduct = await rejects(
      asB((tx, ctx) =>
        createInvoice(tx, ctx, {
          contactId: bCustomer.id,
          lines: [
            { productId: product?.id ?? '', description: 'x', quantity: '1', unitAmount: '1' },
          ],
        }),
      ),
      ValidationError,
    );
    expect(foreignProduct.details?.[0]?.path).toBe('lines.0.productId');
    await rejects(
      asB((tx, ctx) =>
        createInvoice(tx, ctx, {
          contactId: invoice.contact?.id ?? '',
          lines: [{ description: 'x', quantity: '1', unitAmount: '1' }],
        }),
      ),
      ValidationError,
    );
    const foreignTax = await inOrg(A(), aOwner(), (tx, ctx) =>
      createTaxRate(tx, ctx, { name: 'VAT A', percent: '10' }),
    );
    await rejects(
      asB((tx, ctx) =>
        createInvoice(tx, ctx, {
          contactId: bCustomer.id,
          lines: [{ description: 'x', quantity: '1', unitAmount: '1', taxRateId: foreignTax.id }],
        }),
      ),
      ValidationError,
    );

    // Org B's webhook endpoint cannot settle org A's payment, even with a valid signature.
    const checkout = await startInvoiceCheckout(services, token);
    const providerPaymentId = await providerPaymentIdOf(checkout.paymentId);
    fake.simulate(providerPaymentId, 'captured');
    const bConnection = await connectionOf(B());
    expect(
      await webhook(bConnection.id, {
        id: `evt_${uniqueSuffix()}`,
        payment_id: providerPaymentId,
        status: 'captured',
        reference: checkout.paymentId,
      }),
    ).toBe('ignored');
    const untouched = await inOrg(A(), aOwner(), (tx, ctx) => getInvoice(tx, ctx, invoice.id));
    expect(untouched.status).toBe('open');

    // Tenant scope cannot write payment rows (system-write only), even in its own organization.
    await rejects(
      inOrg(A(), aOwner(), (tx) =>
        tx
          .update(payments)
          .set({ status: 'captured' })
          .where(inArray(payments.id, [checkout.paymentId]))
          .returning(),
      ).then((rows) => {
        if (rows.length === 0) throw new NotFoundError('Payment');
      }),
      NotFoundError,
    );
  });
});
