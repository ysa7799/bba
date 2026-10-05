import {
  handleCommerceWebhook,
  onlinePaymentAvailable,
  refreshPublicInvoicePayments,
  resolvePublicInvoice,
  resolvePublicQuote,
  respondToPublicQuote,
  startInvoiceCheckout,
  syncInvoicePayment,
  type PublicInvoice,
} from '@businessos/commerce';
import { payments, withSystem } from '@businessos/database';
import { FakePaymentProvider } from '@businessos/payments';
import { NotFoundError } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../../lib/validation';

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

/**
 * `/public/commerce/*` — the customer's quote and invoice pages. The link token resolves the
 * tenant (system-scope lookup by its hash); everything else runs in that tenant. Payment state
 * is only ever changed from server-side verification with the provider.
 */
export function publicCommerceRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  async function token(request: FastifyRequest): Promise<string> {
    await app.rateLimiter.consume('commerceDocumentIp', request.ip);
    return parseInput(tokenParams, request.params).token;
  }

  async function invoiceView(invoice: PublicInvoice | null) {
    if (!invoice) throw new NotFoundError('Invoice');
    const payable =
      invoice.invoice.status === 'open' &&
      invoice.invoice.amountDue.amountMinor !== '0' &&
      (await onlinePaymentAvailable(
        app.commerce,
        invoice.organizationId,
        invoice.invoice.currency,
      ));
    return { organization: invoice.organization, invoice: invoice.invoice, payable };
  }

  app.get('/invoices/:token', async (request) => {
    const value = await token(request);
    return invoiceView(await resolvePublicInvoice(db(), value));
  });

  /** Starts (or resumes) an online payment for what is due; returns the provider's page. */
  app.post('/invoices/:token/checkout', async (request) => {
    const value = await token(request);
    await app.rateLimiter.consume('commerceCheckoutIp', request.ip);
    await app.rateLimiter.consume('commerceCheckoutDocument', value);
    const result = await startInvoiceCheckout(app.commerce, value, request.body ?? {});
    return { redirectUrl: result.redirectUrl };
  });

  /**
   * The customer is back from the provider. Query strings and "success" flags are ignored: the
   * server re-fetches the invoice's pending payments from the provider.
   */
  app.post('/invoices/:token/refresh', async (request) => {
    const value = await token(request);
    await app.rateLimiter.consume('commerceCheckoutDocument', value);
    await refreshPublicInvoicePayments(app.commerce, value);
    return invoiceView(await resolvePublicInvoice(db(), value));
  });

  app.get('/quotes/:token', async (request) => {
    const value = await token(request);
    const quote = await resolvePublicQuote(db(), value);
    if (!quote) throw new NotFoundError('Quote');
    return { organization: quote.organization, quote: quote.quote };
  });

  app.post('/quotes/:token/respond', async (request) => {
    const value = await token(request);
    await app.rateLimiter.consume('commerceRespondIp', request.ip);
    const quote = await respondToPublicQuote(
      db(),
      value,
      request.body as Parameters<typeof respondToPublicQuote>[2],
    );
    return { organization: quote.organization, quote: quote.quote };
  });
}

/**
 * `/webhooks/commerce/:connectionId` — payment notifications for an organization's own provider
 * account. Encapsulated so the raw body is available for signature verification.
 */
export async function commerceWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post('/:connectionId', async (request) => {
    const { connectionId } = parseInput(z.object({ connectionId: z.uuid() }), request.params);
    await app.rateLimiter.consume('commerceWebhookConnection', connectionId);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const outcome = await handleCommerceWebhook(
      app.commerce,
      connectionId,
      body,
      request.headers,
      request.id,
    );
    return { received: true, outcome };
  });
  await Promise.resolve();
}

/**
 * Development only: what the fake provider's hosted page does when the customer pays (or
 * fails), followed by the same server-side verification a real webhook triggers.
 */
export function devCommercePaymentRoutes(app: FastifyInstance): void {
  app.post('/fake-payments/:providerPaymentId/complete', async (request) => {
    const { providerPaymentId } = parseInput(
      z.object({ providerPaymentId: z.string().regex(/^fake_[a-f0-9]{16}$/) }),
      request.params,
    );
    const { status } = parseInput(
      z.object({ status: z.enum(['captured', 'failed']) }),
      request.body,
    );
    const fake = app.commerce.providers.get('fake')?.create({});
    if (!(fake instanceof FakePaymentProvider)) throw new NotFoundError('Route');
    // System scope: development-only lookup of a fake invoice payment by provider reference.
    const [payment] = await withSystem(db(app), (tx) =>
      tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.purpose, 'invoice'),
            eq(payments.provider, 'fake'),
            eq(payments.providerPaymentId, providerPaymentId),
          ),
        ),
    );
    if (!payment) throw new NotFoundError('Payment');
    fake.simulate(providerPaymentId, status);
    const result = await syncInvoicePayment(app.commerce, payment.id, request.id);
    return { status: result.status };
  });
}

function db(app: FastifyInstance) {
  return app.deps.db.db;
}
