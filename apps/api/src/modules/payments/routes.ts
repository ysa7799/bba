import { payments, withSystem } from '@businessos/database';
import {
  createSubscriptionCheckout,
  FakePaymentProvider,
  getCheckout,
  handlePaymentWebhook,
  listPayments,
  syncPayment,
  type PaymentServices,
} from '@businessos/payments';
import { isCurrencyCode, money, NotFoundError, toMoneyJson } from '@businessos/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';
import { requirePermission, resolveTenant, tenantScope } from '../../plugins/tenant';

const checkoutSchema = z.object({
  priceId: z.uuid(),
  method: z.enum(['all', 'card', 'apple_pay', 'benefit']).optional(),
});
const idParamSchema = z.object({ id: z.uuid() });

function moneyOf(amountMinor: bigint, currency: string): ReturnType<typeof toMoneyJson> | null {
  return isCurrencyCode(currency) ? toMoneyJson(money(amountMinor, currency)) : null;
}

function services(app: FastifyInstance): PaymentServices {
  return app.payments;
}

/** `/app/billing/payments-config`: whether checkout is available (UI only shows real options). */
export function paymentConfigRoutes(app: FastifyInstance): void {
  app.get('/payments-config', (request) => {
    requireAuth(request);
    const name = app.deps.env.PAYMENTS_PROVIDER;
    if (name === 'none' || !app.payments.providers.has(name)) {
      return { provider: null, status: 'disabled', methods: [] };
    }
    const provider = app.payments.providers.get(name);
    return {
      provider: provider.name,
      status: provider.status(),
      methods: provider.capabilities.methods.map((method) => method.method),
    };
  });
}

/** `/app/orgs/:orgId/billing/*` payment routes. */
export function organizationPaymentRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  app.post('/checkout', async (request, reply) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    await app.rateLimiter.consume('checkoutOrg', tenant.organizationId);
    const input = parseInput(checkoutSchema, request.body);
    const result = await createSubscriptionCheckout(
      services(app),
      {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        audit: auditContext(request),
        correlationId: request.id,
      },
      input,
    );
    return reply.status(201).send(result);
  });

  app.get('/checkout/:id', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    const { id } = parseInput(idParamSchema, request.params);
    const { checkout, payment } = await getCheckout(app.deps.db.db, tenantScope(tenant), id);
    return {
      checkout: { id: checkout.id, status: checkout.status, expiresAt: checkout.expiresAt },
      payment: {
        id: payment.id,
        status: payment.status,
        amount: moneyOf(payment.amountMinor, payment.currency),
      },
    };
  });

  /**
   * Called by the return page. The client's query string (provider ids, "success" flags) is
   * ignored: the server re-fetches the payment from the provider using the id it stored.
   */
  app.post('/checkout/:id/verify', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    await app.rateLimiter.consume('checkoutVerifyOrg', tenant.organizationId);
    const { id } = parseInput(idParamSchema, request.params);
    const { payment } = await getCheckout(app.deps.db.db, tenantScope(tenant), id);
    const result = await syncPayment(services(app), payment.id, request.id);
    const { checkout } = await getCheckout(app.deps.db.db, tenantScope(tenant), id);
    return {
      checkout: { id: checkout.id, status: checkout.status },
      payment: { status: result.status },
    };
  });

  app.get('/payments', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    const rows = await listPayments(app.deps.db.db, tenantScope(tenant));
    return {
      data: rows.map((row) => ({
        id: row.id,
        purpose: row.purpose,
        provider: row.provider,
        status: row.status,
        method: row.method,
        amount: moneyOf(row.amountMinor, row.currency),
        refunded: moneyOf(row.refundedAmountMinor, row.currency),
        createdAt: row.createdAt,
        capturedAt: row.capturedAt,
      })),
    };
  });
}

/**
 * `/webhooks/payments/:provider`. Encapsulated so the raw body is available for signature
 * verification; no cookies or CSRF rules apply here (authenticity comes from the signature).
 */
export async function paymentWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    '/payments/:provider',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const { provider } = parseInput(
        z.object({ provider: z.string().regex(/^[a-z0-9_-]{1,40}$/) }),
        request.params,
      );
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const outcome = await handlePaymentWebhook(
        services(app),
        provider,
        body,
        request.headers,
        request.id,
      );
      return { received: true, outcome };
    },
  );
  await Promise.resolve();
}

/**
 * Development-only: completes a fake-provider checkout (what the hosted payment page would
 * do), then syncs it server-side exactly like a real webhook would trigger.
 */
export function devPaymentRoutes(app: FastifyInstance): void {
  app.post('/payments/fake/:providerPaymentId/complete', async (request) => {
    const auth = requireAuth(request);
    const { providerPaymentId } = parseInput(
      z.object({ providerPaymentId: z.string().regex(/^fake_[a-f0-9]{16}$/) }),
      request.params,
    );
    const { status } = parseInput(
      z.object({ status: z.enum(['captured', 'failed']) }),
      request.body,
    );
    const provider = app.payments.providers.get('fake');
    if (!(provider instanceof FakePaymentProvider)) throw new NotFoundError('Route');
    // System scope: development-only lookup of a fake payment by provider reference.
    const [payment] = await withSystem(app.deps.db.db, (tx) =>
      tx
        .select()
        .from(payments)
        .where(
          and(eq(payments.provider, 'fake'), eq(payments.providerPaymentId, providerPaymentId)),
        ),
    );
    if (!payment) throw new NotFoundError('Payment');
    // The dev page may only complete payments the signed-in user started.
    if (payment.createdByUserId !== auth.user.id) throw new NotFoundError('Payment');
    provider.simulate(providerPaymentId, status);
    const result = await syncPayment(app.payments, payment.id, request.id);
    return { status: result.status, organizationId: payment.organizationId };
  });
}
