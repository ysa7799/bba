import { recordAudit, type AuditContext } from '@businessos/audit';
import type { CrmContext } from '@businessos/crm';
import { displayName } from '@businessos/crm';
import {
  commerceCheckouts,
  commerceInvoicePayments,
  commerceInvoices,
  commercePaymentConnections,
  commerceRefunds,
  crmContacts,
  MANUAL_PAYMENT_METHODS,
  paymentWebhookEvents,
  payments,
  withSystem,
  withTenant,
  type CommerceInvoice,
  type CommerceInvoicePayment,
  type CommercePaymentConnection,
  type Payment,
  type TenantTx,
  type Tx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  canTransition,
  isPaid,
  WebhookSignatureError,
  type NormalizedPaymentStatus,
  type PaymentMethodType,
  type ProviderPayment,
  type ProviderRefund,
  type WebhookOutcome,
} from '@businessos/payments';
import {
  ConflictError,
  isCurrencyCode,
  isUuid,
  money,
  NotFoundError,
  redactSensitive,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from '@businessos/shared';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  getLiveConnectionRow,
  commerceWebhookUrl,
  providerForConnection,
  type CommerceServices,
} from './connections';
import {
  amountDueMinor,
  DOCUMENT_TOKEN,
  getInvoice,
  getInvoiceRow,
  hashDocumentToken,
  settleInvoice,
  type EventMeta,
  type InvoiceDetail,
} from './invoices';
import { parseUnitAmount } from './money';

/** A pending checkout for the same amount is reused for this long (no duplicate charges). */
const CHECKOUT_REUSE_MS = 30 * 60 * 1000;

function currencyOf(code: string) {
  if (!isCurrencyCode(code)) throw new UnprocessableError('Unsupported currency');
  return code;
}

// ── Online payments (customer pays through the organization's provider) ──────────────────

export const checkoutInputSchema = z.object({
  method: z.enum(['card', 'apple_pay', 'benefit', 'mada', 'knet', 'all']).optional(),
});

/**
 * Starts an online payment for what is due on an invoice, from the customer's link. The amount
 * is computed on the server; the payment row is created before the provider is called and its
 * id is the provider idempotency key, so every provider charge maps to one internal payment.
 */
export async function startInvoiceCheckout(
  services: CommerceServices,
  token: string,
  rawInput: z.input<typeof checkoutInputSchema> = {},
): Promise<{ paymentId: string; redirectUrl: string }> {
  const input = checkoutInputSchema.parse(rawInput);
  if (!DOCUMENT_TOKEN.test(token)) throw new NotFoundError('Invoice');
  const method: PaymentMethodType | 'all' = input.method ?? 'all';

  // System scope: the customer is anonymous and the link token identifies the organization;
  // every query below is filtered by that organization, and payment rows are system-write only.
  const prepared = await withSystem(services.db, async (tx) => {
    const [found] = await tx
      .select()
      .from(commerceInvoices)
      .where(eq(commerceInvoices.publicTokenHash, hashDocumentToken(token)))
      .for('update');
    if (!found || found.status === 'draft' || found.status === 'void')
      throw new NotFoundError('Invoice');
    const invoice = found;
    if (invoice.status !== 'open') throw new ConflictError('This invoice is already paid');
    const due = amountDueMinor(invoice);
    if (due <= 0n) throw new ConflictError('Nothing is due on this invoice');
    const connection = await getLiveConnectionRow(tx, invoice.organizationId);
    const provider = connection ? providerForConnection(services, connection) : null;
    if (!connection || !provider) {
      throw new UnprocessableError('Online payment is not available for this invoice');
    }
    const supported = provider.capabilities.methods.some(
      (entry) =>
        (method === 'all' || entry.method === method) &&
        entry.currencies.includes(invoice.currency),
    );
    if (!supported)
      throw new UnprocessableError('This payment method does not support the invoice currency');

    const [recent] = await tx
      .select({ paymentId: payments.id, redirectUrl: commerceCheckouts.redirectUrl })
      .from(commerceCheckouts)
      .innerJoin(payments, eq(payments.id, commerceCheckouts.paymentId))
      .where(
        and(
          eq(commerceCheckouts.invoiceId, invoice.id),
          eq(commerceCheckouts.organizationId, invoice.organizationId),
          eq(commerceCheckouts.connectionId, connection.id),
          inArray(payments.status, ['pending', 'requires_action']),
          eq(payments.amountMinor, due),
          isNotNull(commerceCheckouts.redirectUrl),
          gt(commerceCheckouts.createdAt, new Date(Date.now() - CHECKOUT_REUSE_MS)),
        ),
      )
      .orderBy(desc(commerceCheckouts.createdAt))
      .limit(1);
    if (recent?.redirectUrl && method === 'all') {
      return {
        kind: 'reuse',
        paymentId: recent.paymentId,
        redirectUrl: recent.redirectUrl,
      } as const;
    }

    const [contact] = await tx
      .select()
      .from(crmContacts)
      .where(
        and(
          eq(crmContacts.id, invoice.contactId),
          eq(crmContacts.organizationId, invoice.organizationId),
        ),
      );
    const [payment] = await tx
      .insert(payments)
      .values({
        organizationId: invoice.organizationId,
        purpose: 'invoice',
        provider: connection.provider,
        amountMinor: due,
        currency: invoice.currency,
      })
      .returning();
    if (!payment) throw new Error('payment insert returned no row');
    const [checkout] = await tx
      .insert(commerceCheckouts)
      .values({
        organizationId: invoice.organizationId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        connectionId: connection.id,
      })
      .returning();
    if (!checkout) throw new Error('checkout insert returned no row');
    return {
      kind: 'new',
      invoice,
      connection,
      provider,
      payment,
      checkout,
      customer: {
        name: contact ? displayName(contact) || 'Customer' : 'Customer',
        email: contact?.email ?? '',
      },
    } as const;
  });
  if (prepared.kind === 'reuse')
    return { paymentId: prepared.paymentId, redirectUrl: prepared.redirectUrl };

  const { invoice, connection, provider, payment, checkout, customer } = prepared;
  const returnUrl = new URL(`/i/${token}`, `${services.appUrl}/`);
  returnUrl.searchParams.set('payment', payment.id);
  try {
    const result = await provider.createCheckout({
      reference: payment.id,
      amount: money(payment.amountMinor, currencyOf(payment.currency)),
      description: `Invoice ${invoice.number ?? ''}`.trim(),
      customer,
      returnUrl: returnUrl.toString(),
      webhookUrl: commerceWebhookUrl(services, connection.id),
      method,
      metadata: { organizationId: invoice.organizationId, invoiceId: invoice.id },
      idempotencyKey: payment.id,
    });
    // System scope: payment rows are written by the platform only.
    await withSystem(services.db, async (tx) => {
      await tx
        .update(payments)
        .set({ providerPaymentId: result.providerPaymentId })
        .where(
          and(eq(payments.id, payment.id), eq(payments.organizationId, invoice.organizationId)),
        );
      await tx
        .update(commerceCheckouts)
        .set({ redirectUrl: result.redirectUrl })
        .where(
          and(
            eq(commerceCheckouts.id, checkout.id),
            eq(commerceCheckouts.organizationId, invoice.organizationId),
          ),
        );
    });
    return { paymentId: payment.id, redirectUrl: result.redirectUrl };
  } catch (error) {
    // System scope: payment rows are written by the platform only.
    await withSystem(services.db, (tx) =>
      tx
        .update(payments)
        .set({ status: 'failed', failureCode: 'checkout_creation_failed' })
        .where(
          and(eq(payments.id, payment.id), eq(payments.organizationId, invoice.organizationId)),
        ),
    );
    throw error;
  }
}

function mismatch(payment: Payment, remote: ProviderPayment): string | null {
  if (remote.amount.currency !== payment.currency) return 'currency_mismatch';
  if (remote.amount.amountMinor !== payment.amountMinor) return 'amount_mismatch';
  if (remote.reference !== null && remote.reference !== payment.id) return 'reference_mismatch';
  return null;
}

export interface InvoicePaymentSync {
  status: NormalizedPaymentStatus;
  changed: boolean;
  /** The payment was applied to the invoice by this call. */
  applied: boolean;
}

async function loadInvoicePayment(services: CommerceServices, paymentId: string) {
  // System scope: payment verification runs for webhooks and anonymous customers alike.
  const [row] = await withSystem(services.db, (tx) =>
    tx
      .select({
        payment: payments,
        checkout: commerceCheckouts,
        connection: commercePaymentConnections,
      })
      .from(payments)
      .innerJoin(
        commerceCheckouts,
        and(
          eq(commerceCheckouts.paymentId, payments.id),
          eq(commerceCheckouts.organizationId, payments.organizationId),
        ),
      )
      .innerJoin(
        commercePaymentConnections,
        and(
          eq(commercePaymentConnections.id, commerceCheckouts.connectionId),
          eq(commercePaymentConnections.organizationId, commerceCheckouts.organizationId),
        ),
      )
      .where(and(eq(payments.id, paymentId), eq(payments.purpose, 'invoice'))),
  );
  return row ?? null;
}

/**
 * Brings an invoice payment in line with the provider's authoritative state (server-side
 * retrieval through the organization's connection) and applies it to the invoice exactly once,
 * on the transition into a paid state. Safe to call any number of times, concurrently, from
 * webhooks, the customer's return page or staff. Amount, currency and reference must match
 * what was requested, or the payment is refused.
 */
export async function syncInvoicePayment(
  services: CommerceServices,
  paymentId: string,
  correlationId: string | null = null,
): Promise<InvoicePaymentSync> {
  const loaded = await loadInvoicePayment(services, paymentId);
  if (!loaded) throw new NotFoundError('Payment');
  const { checkout, connection } = loaded;
  if (!loaded.payment.providerPaymentId) {
    return { status: loaded.payment.status, changed: false, applied: false };
  }
  const provider = providerForConnection(services, connection);
  if (!provider) throw new UnprocessableError('The payment connection is not available');
  const remote = await provider.retrievePayment(loaded.payment.providerPaymentId);
  const meta = { actor: { type: 'system' as const, id: null }, correlationId };

  // System scope: payment state is maintained by the platform from verified provider data;
  // every statement is filtered by the payment's organization.
  return withSystem(services.db, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.organizationId, checkout.organizationId)))
      .for('update');
    if (!payment) throw new NotFoundError('Payment');
    const problem = mismatch(payment, remote);
    if (problem) {
      services.logger?.error(
        { paymentId, problem, provider: payment.provider },
        'provider payment does not match the expected invoice payment; refusing to apply it',
      );
      if (payment.status !== 'failed' && !isPaid(payment.status)) {
        await tx
          .update(payments)
          .set({ status: 'failed', failureCode: problem, lastVerifiedAt: new Date() })
          .where(
            and(eq(payments.id, payment.id), eq(payments.organizationId, payment.organizationId)),
          );
      }
      return { status: 'failed', changed: true, applied: false };
    }

    const refundedChanged = remote.refunded.amountMinor !== payment.refundedAmountMinor;
    if (
      !canTransition(payment.status, remote.status) ||
      (payment.status === remote.status && !refundedChanged)
    ) {
      await tx
        .update(payments)
        .set({ lastVerifiedAt: new Date() })
        .where(
          and(eq(payments.id, payment.id), eq(payments.organizationId, payment.organizationId)),
        );
      return { status: payment.status, changed: false, applied: false };
    }

    const becamePaid = !isPaid(payment.status) && isPaid(remote.status);
    await tx
      .update(payments)
      .set({
        status: remote.status,
        method: remote.method,
        failureCode: remote.failureCode,
        failureMessage: remote.failureMessage?.slice(0, 500) ?? null,
        refundedAmountMinor: remote.refunded.amountMinor,
        capturedAt: becamePaid ? new Date() : payment.capturedAt,
        lastVerifiedAt: new Date(),
      })
      .where(and(eq(payments.id, payment.id), eq(payments.organizationId, payment.organizationId)));

    let applied = false;
    if (becamePaid) {
      const invoice = await getInvoiceRow(tx, payment.organizationId, checkout.invoiceId, {
        lock: true,
      });
      const inserted = await tx
        .insert(commerceInvoicePayments)
        .values({
          organizationId: payment.organizationId,
          invoiceId: invoice.id,
          source: 'online',
          paymentId: payment.id,
          method: remote.method ?? 'card',
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          reference: remote.providerPaymentId.slice(0, 200),
          receivedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: commerceInvoicePayments.id });
      applied = inserted.length > 0;
      if (applied) {
        if (invoice.status !== 'open') {
          // Paid after the invoice was settled or voided: recorded so staff can refund it.
          services.logger?.warn(
            { invoiceId: invoice.id, paymentId: payment.id, invoiceStatus: invoice.status },
            'online payment received for an invoice that was no longer open',
          );
        }
        await settleInvoice(tx, invoice, meta);
      }
      await emitEvent(tx, {
        type: 'payment.succeeded',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: meta.actor,
        payload: {
          paymentId: payment.id,
          purpose: 'invoice',
          amountMinor: String(payment.amountMinor),
          currency: payment.currency,
        },
        correlationId,
      });
    } else if (remote.status === 'failed' || remote.status === 'canceled') {
      await emitEvent(tx, {
        type: 'payment.failed',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: meta.actor,
        payload: { paymentId: payment.id, purpose: 'invoice', failureCode: remote.failureCode },
        correlationId,
      });
    } else if (remote.status === 'refunded' || remote.status === 'partially_refunded') {
      await emitEvent(tx, {
        type: 'payment.refunded',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: meta.actor,
        payload: {
          paymentId: payment.id,
          refundedMinor: String(remote.refunded.amountMinor),
          currency: payment.currency,
        },
        correlationId,
      });
      const [ledger] = await tx
        .select({
          id: commerceInvoicePayments.id,
          refundedMinor: commerceInvoicePayments.refundedMinor,
        })
        .from(commerceInvoicePayments)
        .where(
          and(
            eq(commerceInvoicePayments.paymentId, payment.id),
            eq(commerceInvoicePayments.organizationId, payment.organizationId),
          ),
        );
      if (ledger && remote.refunded.amountMinor >= ledger.refundedMinor) {
        // The provider has completed everything we asked it to refund.
        await tx
          .update(commerceRefunds)
          .set({ status: 'succeeded', completedAt: new Date() })
          .where(
            and(
              eq(commerceRefunds.invoicePaymentId, ledger.id),
              eq(commerceRefunds.organizationId, payment.organizationId),
              eq(commerceRefunds.status, 'pending'),
            ),
          );
      }
      if (ledger && remote.refunded.amountMinor > ledger.refundedMinor) {
        // Refunded in the provider's dashboard: never silently rewrite the invoice ledger.
        services.logger?.error(
          { paymentId: payment.id, providerRefundedMinor: String(remote.refunded.amountMinor) },
          'provider reports refunds that were not made through BusinessOS; reconcile the invoice',
        );
      }
    }
    return { status: remote.status, changed: true, applied };
  });
}

function fingerprint(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex').slice(0, 40);
}

/**
 * A provider notification for an organization's connection: authenticate with that
 * connection's credentials → record once (replay protection, idempotency) → resolve the
 * payment of that connection → re-fetch and sync. The notification's own status is never used.
 */
export async function handleCommerceWebhook(
  services: CommerceServices,
  connectionId: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  correlationId: string | null = null,
): Promise<WebhookOutcome> {
  if (!isUuid(connectionId)) throw new NotFoundError('Webhook endpoint');
  // System scope: the webhook is unauthenticated until the signature is verified with this
  // connection's credentials; the connection identifies the organization.
  const [connection] = await withSystem(services.db, (tx) =>
    tx
      .select()
      .from(commercePaymentConnections)
      .where(eq(commercePaymentConnections.id, connectionId)),
  );
  const provider = connection ? providerForConnection(services, connection) : null;
  if (!connection || !provider) throw new NotFoundError('Webhook endpoint');
  const providerKey = `commerce:${connection.id}`;

  let event;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (error) {
    // System scope: webhook diagnostics are platform-level.
    await withSystem(services.db, (tx) =>
      tx
        .insert(paymentWebhookEvents)
        .values({
          provider: providerKey,
          providerEventId: `invalid:${fingerprint(rawBody)}`,
          signatureValid: false,
          status: 'rejected',
          organizationId: connection.organizationId,
          error: error instanceof WebhookSignatureError ? 'invalid signature' : 'malformed payload',
        })
        .onConflictDoNothing(),
    );
    throw new UnauthenticatedError('Invalid webhook signature');
  }
  if (event === null) return 'ignored';

  // System scope: webhook bookkeeping is platform-level.
  const inserted = await withSystem(services.db, (tx) =>
    tx
      .insert(paymentWebhookEvents)
      .values({
        provider: providerKey,
        providerEventId: event.providerEventId.slice(0, 300),
        signatureValid: true,
        providerPaymentId: event.providerPaymentId,
        organizationId: connection.organizationId,
        payload: redactSensitive(event.raw) as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id }),
  );
  const record = inserted[0];
  if (!record) return 'duplicate';

  // System scope: resolve the payment of this connection (filtered by its organization).
  const [match] = await withSystem(services.db, (tx) =>
    tx
      .select({ id: payments.id })
      .from(payments)
      .innerJoin(
        commerceCheckouts,
        and(
          eq(commerceCheckouts.paymentId, payments.id),
          eq(commerceCheckouts.organizationId, payments.organizationId),
        ),
      )
      .where(
        and(
          eq(payments.purpose, 'invoice'),
          eq(payments.organizationId, connection.organizationId),
          eq(payments.provider, connection.provider),
          eq(payments.providerPaymentId, event.providerPaymentId),
          eq(commerceCheckouts.connectionId, connection.id),
        ),
      ),
  );
  const markEvent = (status: 'processed' | 'ignored', error: string | null) =>
    // System scope: webhook bookkeeping is platform-level.
    withSystem(services.db, (tx) =>
      tx
        .update(paymentWebhookEvents)
        .set({ status, error, processedAt: new Date() })
        .where(eq(paymentWebhookEvents.id, record.id)),
    );
  if (!match) {
    await markEvent('ignored', 'unknown payment');
    services.logger?.warn(
      { connectionId: connection.id },
      'commerce webhook for an unknown payment ignored',
    );
    return 'ignored';
  }
  try {
    await syncInvoicePayment(services, match.id, correlationId);
    await markEvent('processed', null);
    return 'processed';
  } catch (error) {
    // Let the provider's retry process it again.
    await withSystem(services.db, (tx) =>
      tx.delete(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, record.id)),
    );
    throw error;
  }
}

/** Re-verifies recent unfinished online payments of an invoice (return page, staff refresh). */
async function refreshCheckouts(
  services: CommerceServices,
  organizationId: string,
  invoiceId: string,
): Promise<void> {
  // System scope: reads payment state for one invoice of the given organization.
  const open = await withSystem(services.db, (tx) =>
    tx
      .select({ id: payments.id })
      .from(commerceCheckouts)
      .innerJoin(payments, eq(payments.id, commerceCheckouts.paymentId))
      .where(
        and(
          eq(commerceCheckouts.invoiceId, invoiceId),
          eq(commerceCheckouts.organizationId, organizationId),
          inArray(payments.status, ['pending', 'requires_action', 'authorized']),
          isNotNull(payments.providerPaymentId),
          gt(commerceCheckouts.createdAt, new Date(Date.now() - 24 * 3600 * 1000)),
        ),
      )
      .orderBy(desc(commerceCheckouts.createdAt))
      .limit(5),
  );
  for (const { id } of open) {
    try {
      await syncInvoicePayment(services, id);
    } catch (error) {
      services.logger?.warn(
        { paymentId: id, error: error instanceof Error ? error.message : 'unknown' },
        'invoice payment verification failed',
      );
    }
  }
}

/** The customer is back from the provider: verify server-side (the redirect proves nothing). */
export async function refreshPublicInvoicePayments(
  services: CommerceServices,
  token: string,
): Promise<void> {
  if (!DOCUMENT_TOKEN.test(token)) return;
  // System scope: the anonymous customer's link token identifies the organization.
  const [found] = await withSystem(services.db, (tx) =>
    tx
      .select({ id: commerceInvoices.id, organizationId: commerceInvoices.organizationId })
      .from(commerceInvoices)
      .where(eq(commerceInvoices.publicTokenHash, hashDocumentToken(token))),
  );
  if (found) await refreshCheckouts(services, found.organizationId, found.id);
}

/** Staff "check payment status": verifies the invoice's pending online payments. */
export async function refreshInvoicePayments(
  services: CommerceServices,
  ctx: CrmContext,
  invoiceId: string,
): Promise<InvoiceDetail> {
  await withTenant(
    services.db,
    { organizationId: ctx.organizationId, userId: ctx.actor.userId },
    (tx) => getInvoiceRow(tx, ctx.organizationId, invoiceId),
  );
  await refreshCheckouts(services, ctx.organizationId, invoiceId);
  return withTenant(
    services.db,
    { organizationId: ctx.organizationId, userId: ctx.actor.userId },
    (tx) => getInvoice(tx, ctx, invoiceId),
  );
}

// ── Payments recorded by staff ───────────────────────────────────────────────────────────

export const manualPaymentInputSchema = z.object({
  /** Decimal amount in the invoice currency (the currency is never taken from the client). */
  amount: z.string().trim().min(1).max(40),
  method: z.enum(MANUAL_PAYMENT_METHODS),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(1_000).nullable().optional(),
});

/**
 * Records money received outside the platform (cash, bank transfer…). At most the amount due:
 * overpayments are refused, so the invoice ledger never needs a hidden credit.
 */
export async function recordManualPayment(
  tx: TenantTx,
  ctx: CrmContext,
  invoiceId: string,
  rawInput: z.input<typeof manualPaymentInputSchema>,
): Promise<{ invoice: InvoiceDetail; paymentId: string; amountMinor: bigint }> {
  const input = manualPaymentInputSchema.parse(rawInput);
  const invoice = await getInvoiceRow(tx, ctx.organizationId, invoiceId, { lock: true });
  if (invoice.status !== 'open')
    throw new ConflictError('Payments can only be recorded on open invoices');
  const amountMinor = parseUnitAmount(input.amount, invoice.currency, 'amount');
  const due = amountDueMinor(invoice);
  if (amountMinor <= 0n) {
    throw new ValidationError('Enter an amount above zero', [
      { path: 'amount', message: 'Must be above zero' },
    ]);
  }
  if (amountMinor > due) {
    throw new ValidationError('The amount is more than what is due', [
      { path: 'amount', message: 'More than the amount due' },
    ]);
  }
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ValidationError('The payment date is in the future', [
      { path: 'receivedAt', message: 'Cannot be in the future' },
    ]);
  }
  const [row] = await tx
    .insert(commerceInvoicePayments)
    .values({
      organizationId: ctx.organizationId,
      invoiceId,
      source: 'manual',
      method: input.method,
      amountMinor,
      currency: invoice.currency,
      reference: input.reference ?? null,
      note: input.note ?? null,
      receivedAt,
      recordedByUserId: ctx.actor.userId,
    })
    .returning({ id: commerceInvoicePayments.id });
  if (!row) throw new Error('payment insert returned no row');
  await settleInvoice(tx, invoice, {
    actor: { type: ctx.actor.type, id: ctx.actor.userId },
    correlationId: ctx.actor.correlationId ?? null,
  });
  return { invoice: await getInvoice(tx, ctx, invoiceId), paymentId: row.id, amountMinor };
}

// ── Refunds ─────────────────────────────────────────────────────────────────────────────

export const refundInputSchema = z.object({
  /** Decimal amount in the payment currency. */
  amount: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(1).max(500),
});

async function lockAppliedPayment(
  tx: Tx,
  organizationId: string,
  invoiceId: string,
  invoicePaymentId: string,
): Promise<CommerceInvoicePayment> {
  const [row] = await tx
    .select()
    .from(commerceInvoicePayments)
    .where(
      and(
        eq(commerceInvoicePayments.id, invoicePaymentId),
        eq(commerceInvoicePayments.invoiceId, invoiceId),
        eq(commerceInvoicePayments.organizationId, organizationId),
      ),
    )
    .for('update');
  if (!row) throw new NotFoundError('Payment');
  return row;
}

async function adjustRefunded(
  tx: Tx,
  invoice: CommerceInvoice,
  applied: CommerceInvoicePayment,
  deltaMinor: bigint,
  meta: EventMeta,
): Promise<void> {
  await tx
    .update(commerceInvoicePayments)
    .set({
      refundedMinor: sql`${commerceInvoicePayments.refundedMinor} + ${deltaMinor.toString()}::bigint`,
    })
    .where(
      and(
        eq(commerceInvoicePayments.id, applied.id),
        eq(commerceInvoicePayments.organizationId, applied.organizationId),
      ),
    );
  await settleInvoice(tx, invoice, meta);
}

/**
 * Refunds (part of) a payment applied to an invoice. Never more than what remains of that
 * payment. Online payments are refunded through the provider: the amount is reserved first
 * (row locks), then the provider is called with the refund id as idempotency key, then the
 * refund is confirmed — or released if the provider refused it.
 */
export async function refundInvoicePayment(
  services: CommerceServices,
  ctx: CrmContext,
  audit: AuditContext,
  invoiceId: string,
  invoicePaymentId: string,
  rawInput: z.input<typeof refundInputSchema>,
): Promise<InvoiceDetail> {
  const input = refundInputSchema.parse(rawInput);
  const scope = { organizationId: ctx.organizationId, userId: ctx.actor.userId };
  const meta = {
    actor: { type: ctx.actor.type, id: ctx.actor.userId },
    correlationId: ctx.actor.correlationId ?? null,
  };

  const reserved = await withTenant(services.db, scope, async (tx) => {
    const invoice = await getInvoiceRow(tx, ctx.organizationId, invoiceId, { lock: true });
    const applied = await lockAppliedPayment(tx, ctx.organizationId, invoiceId, invoicePaymentId);
    const amountMinor = parseUnitAmount(input.amount, applied.currency, 'amount');
    const remaining = applied.amountMinor - applied.refundedMinor;
    if (amountMinor <= 0n) {
      throw new ValidationError('Enter an amount above zero', [
        { path: 'amount', message: 'Must be above zero' },
      ]);
    }
    if (amountMinor > remaining) {
      throw new ValidationError('The amount is more than what can be refunded', [
        { path: 'amount', message: 'More than the refundable amount' },
      ]);
    }
    let providerPaymentId: string | null = null;
    let connection: CommercePaymentConnection | null = null;
    if (applied.source === 'online') {
      const [row] = await tx
        .select({ payment: payments, connection: commercePaymentConnections })
        .from(payments)
        .innerJoin(
          commerceCheckouts,
          and(
            eq(commerceCheckouts.paymentId, payments.id),
            eq(commerceCheckouts.organizationId, payments.organizationId),
          ),
        )
        .innerJoin(
          commercePaymentConnections,
          and(
            eq(commercePaymentConnections.id, commerceCheckouts.connectionId),
            eq(commercePaymentConnections.organizationId, commerceCheckouts.organizationId),
          ),
        )
        .where(
          and(
            eq(payments.id, applied.paymentId ?? ''),
            eq(payments.organizationId, ctx.organizationId),
          ),
        );
      if (!row?.payment.providerPaymentId)
        throw new ConflictError('This payment cannot be refunded online');
      if (!providerForConnection(services, row.connection)) {
        throw new UnprocessableError('Reconnect the payment provider to refund this payment');
      }
      providerPaymentId = row.payment.providerPaymentId;
      connection = row.connection;
    }
    const [refund] = await tx
      .insert(commerceRefunds)
      .values({
        organizationId: ctx.organizationId,
        invoiceId,
        invoicePaymentId,
        amountMinor,
        currency: applied.currency,
        reason: input.reason,
        status: applied.source === 'online' ? 'pending' : 'succeeded',
        completedAt: applied.source === 'online' ? null : new Date(),
        createdByUserId: ctx.actor.userId,
      })
      .returning();
    if (!refund) throw new Error('refund insert returned no row');
    // Reserve the amount now so concurrent refunds can never exceed the payment.
    await adjustRefunded(tx, invoice, applied, amountMinor, meta);
    await recordAudit(tx, audit, {
      organizationId: ctx.organizationId,
      action: 'commerce.refund.created',
      target: { type: 'invoice', id: invoiceId },
      metadata: {
        refundId: refund.id,
        invoicePaymentId,
        amountMinor: amountMinor.toString(),
        currency: applied.currency,
        source: applied.source,
      },
    });
    return { refund, applied, providerPaymentId, connection };
  });

  const { refund, applied, providerPaymentId, connection } = reserved;
  if (applied.source === 'online' && providerPaymentId && connection) {
    let result: ProviderRefund;
    let failure: string | null = null;
    try {
      const provider = providerForConnection(services, connection);
      if (!provider) throw new UnprocessableError('The payment connection is not available');
      result = await provider.refund({
        providerPaymentId,
        amount: money(refund.amountMinor, currencyOf(refund.currency)),
        reason: refund.reason,
        reference: refund.id,
        idempotencyKey: refund.id,
      });
      if (result.status === 'failed') failure = 'The provider declined the refund';
    } catch (error) {
      result = { providerRefundId: '', status: 'failed' };
      failure = error instanceof Error ? error.message.slice(0, 300) : 'Refund failed';
      services.logger?.error({ refundId: refund.id, error: failure }, 'provider refund failed');
    }
    await withTenant(services.db, scope, async (tx) => {
      const invoice = await getInvoiceRow(tx, ctx.organizationId, invoiceId, { lock: true });
      const current = await lockAppliedPayment(tx, ctx.organizationId, invoiceId, invoicePaymentId);
      if (failure) {
        await tx
          .update(commerceRefunds)
          .set({ status: 'failed', failureMessage: failure, completedAt: new Date() })
          .where(
            and(
              eq(commerceRefunds.id, refund.id),
              eq(commerceRefunds.organizationId, ctx.organizationId),
            ),
          );
        // Release the reservation.
        await adjustRefunded(tx, invoice, current, -refund.amountMinor, meta);
        await recordAudit(tx, audit, {
          organizationId: ctx.organizationId,
          action: 'commerce.refund.failed',
          target: { type: 'invoice', id: invoiceId },
          metadata: { refundId: refund.id },
        });
        return;
      }
      await tx
        .update(commerceRefunds)
        .set({
          status: result.status,
          providerRefundId: result.providerRefundId.slice(0, 200) || null,
          completedAt: result.status === 'succeeded' ? new Date() : null,
        })
        .where(
          and(
            eq(commerceRefunds.id, refund.id),
            eq(commerceRefunds.organizationId, ctx.organizationId),
          ),
        );
    });
    if (failure) throw new UnprocessableError(`The refund failed: ${failure}`);
    try {
      await syncInvoicePayment(services, applied.paymentId ?? '', meta.correlationId);
    } catch (error) {
      services.logger?.warn(
        { paymentId: applied.paymentId, error: error instanceof Error ? error.message : 'unknown' },
        'payment re-verification after refund failed',
      );
    }
  }
  return withTenant(services.db, scope, (tx) => getInvoice(tx, ctx, invoiceId));
}

/** Whether the customer can pay an invoice online (an active connection supports its currency). */
export async function onlinePaymentAvailable(
  services: CommerceServices,
  organizationId: string,
  currency: string,
): Promise<boolean> {
  const connection = await withTenant(services.db, { organizationId, userId: null }, (tx) =>
    getLiveConnectionRow(tx, organizationId),
  );
  const provider = connection ? providerForConnection(services, connection) : null;
  return (
    provider?.capabilities.methods.some((method) => method.currencies.includes(currency)) ?? false
  );
}
