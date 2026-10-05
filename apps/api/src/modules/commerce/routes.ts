import { recordAudit, type AuditAction } from '@businessos/audit';
import {
  convertQuoteToInvoice,
  createInvoice,
  createPaymentConnection,
  createProduct,
  createQuote,
  createTaxRate,
  deleteDraftInvoice,
  deleteDraftQuote,
  disconnectPaymentConnection,
  getInvoice,
  getPaymentConnection,
  getProduct,
  getQuote,
  getSettings,
  issueInvoice,
  listInvoices,
  listProducts,
  listProviderOptions,
  listQuotes,
  listTaxRates,
  onlinePaymentAvailable,
  recipientOf,
  recordManualPayment,
  refreshInvoicePayments,
  refundInvoicePayment,
  renewInvoiceLink,
  respondToQuote,
  sendQuote,
  updateInvoice,
  updatePaymentConnection,
  updateProduct,
  updateQuote,
  updateSettings,
  updateTaxRate,
  voidInvoice,
  getInvoiceRow,
  getQuoteRow,
  type InvoiceDetail,
} from '@businessos/commerce';
import type { CrmContext } from '@businessos/crm';
import { withTenant, type TenantTx } from '@businessos/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import {
  requirePermission,
  resolveTenant,
  tenantScope,
  type TenantContext,
} from '../../plugins/tenant';
import { emailDocument, invoiceLink, quoteLink } from './notify';

const idParams = z.object({ id: z.uuid() });
const paymentParams = z.object({ id: z.uuid(), paymentId: z.uuid() });
const sendBody = z.object({ email: z.boolean().default(true) });
const taxListQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
const taxUpdateBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  archived: z.boolean().optional(),
});

function context(request: FastifyRequest, tenant: TenantContext): CrmContext {
  return {
    organizationId: tenant.organizationId,
    countryCode: tenant.organization.countryCode,
    defaultCurrency: tenant.organization.defaultCurrency,
    timezone: tenant.organization.timezone,
    actor: { type: 'user', userId: tenant.userId, correlationId: request.id },
    canRead: {
      contact: tenant.permissions.has('crm.contact.read'),
      company: tenant.permissions.has('crm.company.read'),
      deal: tenant.permissions.has('crm.deal.read'),
    },
  };
}

/** `/app/orgs/:orgId/commerce/*` — catalogue, quotes, invoices, payments and settings. */
export function commerceRoutes(app: FastifyInstance): void {
  const db = () => app.deps.db.db;

  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  function run<T>(
    request: FastifyRequest,
    tenant: TenantContext,
    fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(db(), tenantScope(tenant), (tx) => fn(tx, context(request, tenant)));
  }

  function audit(
    tx: TenantTx,
    request: FastifyRequest,
    tenant: TenantContext,
    action: AuditAction,
    target: { type: string; id: string },
    metadata?: Record<string, unknown>,
  ) {
    return recordAudit(tx, auditContext(request), {
      organizationId: tenant.organizationId,
      action,
      target,
      metadata,
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────

  app.get('/settings', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const settings = await run(request, tenant, (tx) => getSettings(tx, tenant.organizationId));
    return {
      settings,
      onlinePayments: await onlinePaymentAvailable(
        app.commerce,
        tenant.organizationId,
        tenant.organization.defaultCurrency,
      ),
    };
  });

  app.patch('/settings', async (request) => {
    const tenant = requirePermission(request, 'commerce.settings.manage');
    const settings = await run(request, tenant, async (tx, ctx) => {
      const result = await updateSettings(
        tx,
        ctx,
        request.body as Parameters<typeof updateSettings>[2],
      );
      if (result.changedFields.length > 0) {
        await audit(
          tx,
          request,
          tenant,
          'commerce.settings.updated',
          { type: 'organization', id: tenant.organizationId },
          { changedFields: result.changedFields },
        );
      }
      return result.settings;
    });
    return { settings };
  });

  // ── Payment provider account ──────────────────────────────────────────────────────────

  app.get('/payment-connection', async (request) => {
    const tenant = requirePermission(request, 'commerce.settings.manage');
    const connection = await run(request, tenant, (tx, ctx) =>
      getPaymentConnection(tx, ctx, app.commerce),
    );
    return {
      connection,
      providers: listProviderOptions(app.commerce),
      credentialStorage: app.commerce.secretBox !== null,
    };
  });

  app.post('/payment-connection', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.settings.manage');
    const connection = await run(request, tenant, async (tx, ctx) => {
      const created = await createPaymentConnection(
        tx,
        ctx,
        app.commerce,
        request.body as Parameters<typeof createPaymentConnection>[3],
      );
      await audit(
        tx,
        request,
        tenant,
        'commerce.payment_connection.connected',
        { type: 'payment_connection', id: created.id },
        { provider: created.provider, status: created.status },
      );
      return created;
    });
    return reply.status(201).send({ connection });
  });

  app.patch('/payment-connection/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.settings.manage');
    const { id } = parseInput(idParams, request.params);
    const connection = await run(request, tenant, async (tx, ctx) => {
      const updated = await updatePaymentConnection(
        tx,
        ctx,
        app.commerce,
        id,
        request.body as Parameters<typeof updatePaymentConnection>[4],
      );
      await audit(
        tx,
        request,
        tenant,
        'commerce.payment_connection.updated',
        { type: 'payment_connection', id },
        { status: updated.status },
      );
      return updated;
    });
    return { connection };
  });

  app.delete('/payment-connection/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.settings.manage');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, async (tx, ctx) => {
      await disconnectPaymentConnection(tx, ctx, id);
      await audit(tx, request, tenant, 'commerce.payment_connection.disconnected', {
        type: 'payment_connection',
        id,
      });
    });
    return reply.status(204).send();
  });

  // ── Tax rates ─────────────────────────────────────────────────────────────────────────

  app.get('/tax-rates', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const query = parseInput(taxListQuery, request.query);
    return {
      data: await run(request, tenant, (tx) => listTaxRates(tx, tenant.organizationId, query)),
    };
  });

  app.post('/tax-rates', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.catalog.manage');
    const taxRate = await run(request, tenant, async (tx, ctx) => {
      const created = await createTaxRate(
        tx,
        ctx,
        request.body as Parameters<typeof createTaxRate>[2],
      );
      await audit(tx, request, tenant, 'commerce.tax_rate.created', {
        type: 'tax_rate',
        id: created.id,
      });
      return created;
    });
    return reply.status(201).send({ taxRate });
  });

  app.patch('/tax-rates/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.catalog.manage');
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(taxUpdateBody, request.body);
    const taxRate = await run(request, tenant, async (tx, ctx) => {
      const updated = await updateTaxRate(tx, ctx, id, input);
      await audit(
        tx,
        request,
        tenant,
        'commerce.tax_rate.updated',
        { type: 'tax_rate', id },
        { changedFields: Object.keys(input) },
      );
      return updated;
    });
    return { taxRate };
  });

  // ── Products ──────────────────────────────────────────────────────────────────────────

  app.get('/products', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    return run(request, tenant, (tx) =>
      listProducts(tx, tenant.organizationId, request.query as Parameters<typeof listProducts>[2]),
    );
  });

  app.get('/products/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    return {
      product: await run(request, tenant, (tx) => getProduct(tx, tenant.organizationId, id)),
    };
  });

  app.post('/products', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.catalog.manage');
    const product = await run(request, tenant, async (tx, ctx) => {
      const created = await createProduct(
        tx,
        ctx,
        request.body as Parameters<typeof createProduct>[2],
      );
      await audit(tx, request, tenant, 'commerce.product.created', {
        type: 'product',
        id: created.id,
      });
      return created;
    });
    return reply.status(201).send({ product });
  });

  app.patch('/products/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.catalog.manage');
    const { id } = parseInput(idParams, request.params);
    const product = await run(request, tenant, async (tx, ctx) => {
      const updated = await updateProduct(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof updateProduct>[3],
      );
      await audit(
        tx,
        request,
        tenant,
        'commerce.product.updated',
        { type: 'product', id },
        { changedFields: Object.keys(request.body ?? {}).slice(0, 20) },
      );
      return updated;
    });
    return { product };
  });

  // ── Quotes ────────────────────────────────────────────────────────────────────────────

  app.get('/quotes', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    return run(request, tenant, (tx, ctx) =>
      listQuotes(tx, ctx, request.query as Parameters<typeof listQuotes>[2]),
    );
  });

  app.post('/quotes', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const quote = await run(request, tenant, (tx, ctx) =>
      createQuote(tx, ctx, request.body as Parameters<typeof createQuote>[2]),
    );
    return reply.status(201).send({ quote });
  });

  app.get('/quotes/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    return { quote: await run(request, tenant, (tx, ctx) => getQuote(tx, ctx, id)) };
  });

  app.patch('/quotes/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const { id } = parseInput(idParams, request.params);
    return {
      quote: await run(request, tenant, (tx, ctx) =>
        updateQuote(tx, ctx, id, request.body as Parameters<typeof updateQuote>[3]),
      ),
    };
  });

  app.delete('/quotes/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, (tx, ctx) => deleteDraftQuote(tx, ctx, id));
    return reply.status(204).send();
  });

  /** Sends the quote: returns the customer link and emails it when asked and possible. */
  app.post('/quotes/:id/send', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    const { email } = parseInput(sendBody, request.body ?? {});
    const { quote, token, recipient } = await run(request, tenant, async (tx, ctx) => {
      const sent = await sendQuote(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'commerce.quote.sent',
        { type: 'quote', id },
        {
          number: sent.quote.number,
        },
      );
      const row = await getQuoteRow(tx, tenant.organizationId, id);
      return { ...sent, recipient: await recipientOf(tx, tenant.organizationId, row.contactId) };
    });
    const link = quoteLink(app, token);
    const emailed = email
      ? await emailDocument(app, {
          kind: 'quote',
          documentId: quote.id,
          sentAt: quote.sentAt,
          organizationName: tenant.organization.name,
          recipient,
          number: quote.number,
          total: quote.total,
          dueDate: null,
          link,
          correlationId: request.id,
        })
      : false;
    return { quote, link, emailed };
  });

  app.post('/quotes/:id/respond', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    return {
      quote: await run(request, tenant, (tx, ctx) =>
        respondToQuote(tx, ctx, id, request.body as Parameters<typeof respondToQuote>[3]),
      ),
    };
  });

  app.post('/quotes/:id/convert', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const { id } = parseInput(idParams, request.params);
    const invoice = await run(request, tenant, (tx, ctx) => convertQuoteToInvoice(tx, ctx, id));
    return reply.status(201).send({ invoice });
  });

  // ── Invoices ──────────────────────────────────────────────────────────────────────────

  app.get('/invoices', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    return run(request, tenant, (tx, ctx) =>
      listInvoices(tx, ctx, request.query as Parameters<typeof listInvoices>[2]),
    );
  });

  app.post('/invoices', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const invoice = await run(request, tenant, (tx, ctx) =>
      createInvoice(tx, ctx, request.body as Parameters<typeof createInvoice>[2]),
    );
    return reply.status(201).send({ invoice });
  });

  app.get('/invoices/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    return { invoice: await run(request, tenant, (tx, ctx) => getInvoice(tx, ctx, id)) };
  });

  /** The printable document: the invoice with the organization's letterhead and footer. */
  app.get('/invoices/:id/document', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    return run(request, tenant, async (tx, ctx) => ({
      organization: { name: tenant.organization.name },
      footer: (await getSettings(tx, tenant.organizationId)).invoiceFooter,
      invoice: await getInvoice(tx, ctx, id),
    }));
  });

  app.patch('/invoices/:id', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const { id } = parseInput(idParams, request.params);
    return {
      invoice: await run(request, tenant, (tx, ctx) =>
        updateInvoice(tx, ctx, id, request.body as Parameters<typeof updateInvoice>[3]),
      ),
    };
  });

  app.delete('/invoices/:id', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.create');
    const { id } = parseInput(idParams, request.params);
    await run(request, tenant, (tx, ctx) => deleteDraftInvoice(tx, ctx, id));
    return reply.status(204).send();
  });

  async function deliverInvoice(
    request: FastifyRequest,
    tenant: TenantContext,
    sent: { invoice: InvoiceDetail; token: string },
    recipient: { name: string; email: string | null },
    email: boolean,
  ) {
    const link = invoiceLink(app, sent.token);
    const emailed = email
      ? await emailDocument(app, {
          kind: 'invoice',
          documentId: sent.invoice.id,
          sentAt: sent.invoice.sentAt,
          organizationName: tenant.organization.name,
          recipient,
          number: sent.invoice.number ?? '',
          total: sent.invoice.amountDue,
          dueDate: sent.invoice.dueDate,
          link,
          correlationId: request.id,
        })
      : false;
    return { invoice: sent.invoice, link, emailed };
  }

  /** Issues a draft (assigns its number) and returns the customer link; emails it if asked. */
  app.post('/invoices/:id/issue', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    const { email } = parseInput(sendBody, request.body ?? {});
    const { sent, recipient } = await run(request, tenant, async (tx, ctx) => {
      const issued = await issueInvoice(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'commerce.invoice.issued',
        { type: 'invoice', id },
        {
          number: issued.invoice.number,
          totalMinor: issued.invoice.total.amountMinor,
          currency: issued.invoice.currency,
        },
      );
      const row = await getInvoiceRow(tx, tenant.organizationId, id);
      return {
        sent: issued,
        recipient: await recipientOf(tx, tenant.organizationId, row.contactId),
      };
    });
    return deliverInvoice(request, tenant, sent, recipient, email);
  });

  /** A new customer link (the previous one stops working), emailed if asked. */
  app.post('/invoices/:id/resend', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    const { email } = parseInput(sendBody, request.body ?? {});
    const { sent, recipient } = await run(request, tenant, async (tx, ctx) => {
      const renewed = await renewInvoiceLink(tx, ctx, id);
      const row = await getInvoiceRow(tx, tenant.organizationId, id);
      return {
        sent: renewed,
        recipient: await recipientOf(tx, tenant.organizationId, row.contactId),
      };
    });
    return deliverInvoice(request, tenant, sent, recipient, email);
  });

  app.post('/invoices/:id/void', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    const invoice = await run(request, tenant, async (tx, ctx) => {
      const voided = await voidInvoice(tx, ctx, id);
      await audit(
        tx,
        request,
        tenant,
        'commerce.invoice.voided',
        { type: 'invoice', id },
        {
          number: voided.number,
        },
      );
      return voided;
    });
    return { invoice };
  });

  /** Money received outside the platform (cash, transfer…), at most the amount due. */
  app.post('/invoices/:id/payments', async (request, reply) => {
    const tenant = requirePermission(request, 'commerce.invoice.update');
    const { id } = parseInput(idParams, request.params);
    const result = await run(request, tenant, async (tx, ctx) => {
      const recorded = await recordManualPayment(
        tx,
        ctx,
        id,
        request.body as Parameters<typeof recordManualPayment>[3],
      );
      await audit(
        tx,
        request,
        tenant,
        'commerce.payment.recorded',
        { type: 'invoice', id },
        {
          invoicePaymentId: recorded.paymentId,
          amountMinor: recorded.amountMinor.toString(),
          currency: recorded.invoice.currency,
        },
      );
      return recorded;
    });
    return reply.status(201).send({ invoice: result.invoice });
  });

  app.post('/invoices/:id/payments/:paymentId/refund', async (request) => {
    const tenant = requirePermission(request, 'commerce.payment.refund');
    const { id, paymentId } = parseInput(paymentParams, request.params);
    await app.rateLimiter.consume('commerceRefundOrg', tenant.organizationId);
    const invoice = await refundInvoicePayment(
      app.commerce,
      context(request, tenant),
      auditContext(request),
      id,
      paymentId,
      request.body as Parameters<typeof refundInvoicePayment>[5],
    );
    return { invoice };
  });

  /** Re-verifies pending online payments with the provider (never trusts the client). */
  app.post('/invoices/:id/refresh-payments', async (request) => {
    const tenant = requirePermission(request, 'commerce.invoice.read');
    const { id } = parseInput(idParams, request.params);
    await app.rateLimiter.consume('commerceVerifyOrg', tenant.organizationId);
    const invoice = await refreshInvoicePayments(app.commerce, context(request, tenant), id);
    return { invoice };
  });
}
