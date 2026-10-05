import { recordAudit, SYSTEM_AUDIT_CONTEXT, type AuditContext } from '@businessos/audit';
import {
  changeSubscriptionPlan,
  getLiveSubscription,
  startSubscription,
} from '@businessos/billing';
import {
  billingCustomers,
  billingEvents,
  checkoutSessions,
  organizations,
  paymentWebhookEvents,
  payments,
  planVersions,
  plans,
  prices,
  subscriptionItems,
  subscriptions,
  users,
  withSystem,
  withTenant,
  type CheckoutSession,
  type Database,
  type Payment,
  type SystemTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  isCurrencyCode,
  money,
  NotFoundError,
  redactSensitive,
  UnauthenticatedError,
  UnprocessableError,
} from '@businessos/shared';
import { createHash } from 'node:crypto';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { WebhookSignatureError } from './providers/fake';
import type { PaymentProviderRegistry } from './registry';
import { canTransition, isPaid } from './state';
import type { NormalizedPaymentStatus, PaymentMethodType, ProviderPayment } from './types';

export interface PaymentServices {
  db: Database;
  providers: PaymentProviderRegistry;
  /** Provider used for new checkouts. */
  checkoutProvider: string;
  /** Public web app URL (customer return pages). */
  appUrl: string;
  /** Public API URL (provider webhooks). */
  apiPublicUrl: string;
  logger?: { error: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export interface CheckoutContext {
  organizationId: string;
  userId: string;
  audit: AuditContext;
  correlationId: string;
}

const CHECKOUT_TTL_MS = 60 * 60 * 1000;

/** Adds one billing interval in UTC, clamping to the last day of shorter months. */
export function addInterval(start: Date, interval: 'month' | 'year'): Date {
  const months = interval === 'month' ? 1 : 12;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
    ),
  );
}

/**
 * Starts a subscription checkout. The amount comes from the server-side price — never from the
 * client — and the payment row is created before the provider is called so that every provider
 * charge maps to exactly one internal payment (provider idempotency key = payment id).
 */
export async function createSubscriptionCheckout(
  services: PaymentServices,
  context: CheckoutContext,
  input: { priceId: string; method?: PaymentMethodType | 'all' },
): Promise<{ checkoutId: string; paymentId: string; redirectUrl: string }> {
  const provider = services.providers.get(services.checkoutProvider);
  if (provider.status() !== 'ready') {
    throw new UnprocessableError('Online payments are not configured');
  }

  const { price, customer } = await withTenant(
    services.db,
    { organizationId: context.organizationId, userId: context.userId },
    async (tx) => {
      const [row] = await tx
        .select({ price: prices, version: planVersions, plan: plans })
        .from(prices)
        .innerJoin(planVersions, eq(planVersions.id, prices.planVersionId))
        .innerJoin(plans, eq(plans.id, planVersions.planId))
        .where(
          and(
            eq(prices.id, input.priceId),
            eq(prices.status, 'active'),
            eq(planVersions.status, 'published'),
            eq(plans.status, 'active'),
            eq(plans.isPublic, true),
          ),
        );
      if (!row) throw new NotFoundError('Price');
      if (row.price.amountMinor <= 0n) {
        throw new UnprocessableError('Free plans do not need a checkout');
      }
      const methodSupports = provider.capabilities.methods.some(
        (method) =>
          (input.method === undefined ||
            input.method === 'all' ||
            method.method === input.method) &&
          method.currencies.includes(row.price.currency),
      );
      if (!methodSupports) {
        throw new UnprocessableError('This payment method does not support the price currency');
      }
      const [profile] = await tx
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.organizationId, context.organizationId));
      const [organization] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, context.organizationId));
      const [user] = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, context.userId));
      return {
        price: row.price,
        customer: {
          name: profile?.legalName ?? organization?.name ?? 'Customer',
          email: profile?.billingEmail ?? user?.email ?? '',
        },
      };
    },
  );
  if (!isCurrencyCode(price.currency)) throw new UnprocessableError('Unsupported currency');
  const amount = money(price.amountMinor, price.currency);

  // System scope: payment and checkout rows are never writable from tenant scope.
  const { payment, checkout } = await withSystem(services.db, async (tx) => {
    const [createdPayment] = await tx
      .insert(payments)
      .values({
        organizationId: context.organizationId,
        purpose: 'subscription',
        provider: provider.name,
        amountMinor: amount.amountMinor,
        currency: amount.currency,
        createdByUserId: context.userId,
      })
      .returning();
    if (!createdPayment) throw new Error('payment insert returned no row');
    const [createdCheckout] = await tx
      .insert(checkoutSessions)
      .values({
        organizationId: context.organizationId,
        planVersionId: price.planVersionId,
        priceId: price.id,
        paymentId: createdPayment.id,
        expiresAt: new Date(Date.now() + CHECKOUT_TTL_MS),
        createdByUserId: context.userId,
      })
      .returning();
    if (!createdCheckout) throw new Error('checkout insert returned no row');
    await recordAudit(tx, context.audit, {
      organizationId: context.organizationId,
      action: 'billing.checkout_started',
      target: { type: 'checkout', id: createdCheckout.id },
      metadata: {
        priceId: price.id,
        amountMinor: String(amount.amountMinor),
        currency: amount.currency,
      },
    });
    return { payment: createdPayment, checkout: createdCheckout };
  });

  const returnUrl = new URL(`/o/${context.organizationId}/billing/return`, `${services.appUrl}/`);
  returnUrl.searchParams.set('checkout', checkout.id);
  try {
    const result = await provider.createCheckout({
      reference: payment.id,
      amount,
      description: 'BusinessOS subscription',
      customer,
      returnUrl: returnUrl.toString(),
      webhookUrl: `${services.apiPublicUrl}/webhooks/payments/${provider.name}`,
      method: input.method ?? 'all',
      metadata: { organizationId: context.organizationId, checkoutId: checkout.id },
      idempotencyKey: payment.id,
    });
    await withSystem(services.db, async (tx) => {
      await tx
        .update(payments)
        .set({ providerPaymentId: result.providerPaymentId })
        .where(eq(payments.id, payment.id));
      await tx
        .update(checkoutSessions)
        .set({ redirectUrl: result.redirectUrl })
        .where(eq(checkoutSessions.id, checkout.id));
    });
    return { checkoutId: checkout.id, paymentId: payment.id, redirectUrl: result.redirectUrl };
  } catch (error) {
    await withSystem(services.db, async (tx) => {
      await tx
        .update(payments)
        .set({ status: 'failed', failureCode: 'checkout_creation_failed' })
        .where(eq(payments.id, payment.id));
      await tx
        .update(checkoutSessions)
        .set({ status: 'failed' })
        .where(eq(checkoutSessions.id, checkout.id));
    });
    throw error;
  }
}

export interface SyncResult {
  status: NormalizedPaymentStatus;
  changed: boolean;
  fulfilled: boolean;
}

function mismatch(payment: Payment, remote: ProviderPayment): string | null {
  if (remote.amount.currency !== payment.currency) return 'currency_mismatch';
  if (remote.amount.amountMinor !== payment.amountMinor) return 'amount_mismatch';
  if (remote.reference !== null && remote.reference !== payment.id) return 'reference_mismatch';
  return null;
}

async function fulfilSubscription(
  tx: SystemTx,
  payment: Payment,
  checkout: CheckoutSession,
  correlationId: string | undefined,
): Promise<void> {
  const [price] = await tx.select().from(prices).where(eq(prices.id, checkout.priceId));
  if (!price) throw new NotFoundError('Price');
  const live = await getLiveSubscription(tx, payment.organizationId);
  const now = new Date();
  // Renewing the same plan early extends from the current period end.
  const periodStart =
    live?.planVersionId === checkout.planVersionId &&
    live.currentPeriodEnd !== null &&
    live.currentPeriodEnd > now
      ? live.currentPeriodEnd
      : now;
  const periodEnd = addInterval(periodStart, price.interval);

  let subscriptionId: string;
  if (live) {
    if (live.planVersionId !== checkout.planVersionId) {
      await changeSubscriptionPlan(
        tx,
        payment.organizationId,
        checkout.planVersionId,
        correlationId,
      );
    }
    await tx
      .update(subscriptions)
      .set({
        status: 'active',
        provider: payment.provider,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      })
      .where(eq(subscriptions.id, live.id));
    subscriptionId = live.id;
  } else {
    const created = await startSubscription(tx, {
      organizationId: payment.organizationId,
      planVersionId: checkout.planVersionId,
      status: 'active',
      provider: payment.provider,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      correlationId,
    });
    subscriptionId = created.id;
  }
  await tx.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId));
  await tx.insert(subscriptionItems).values({
    organizationId: payment.organizationId,
    subscriptionId,
    priceId: price.id,
    quantity: 1,
  });
  await tx
    .update(checkoutSessions)
    .set({ status: 'completed', completedAt: now })
    .where(eq(checkoutSessions.id, checkout.id));
  await tx.insert(billingEvents).values({
    organizationId: payment.organizationId,
    type: 'subscription.paid',
    data: { paymentId: payment.id, subscriptionId, periodEnd: periodEnd.toISOString() },
  });
  await recordAudit(tx, SYSTEM_AUDIT_CONTEXT, {
    organizationId: payment.organizationId,
    action: 'billing.subscription_activated',
    target: { type: 'subscription', id: subscriptionId },
    metadata: { paymentId: payment.id, planVersionId: checkout.planVersionId },
  });
}

/**
 * Brings a payment in line with the provider's authoritative state (server-side retrieval).
 * Safe to call any number of times, from webhooks, return-page verification or reconciliation:
 * the payment row is locked, status only moves forward and fulfilment happens once (on the
 * transition into a paid state).
 */
export async function syncPayment(
  services: PaymentServices,
  paymentId: string,
  correlationId?: string,
): Promise<SyncResult> {
  // System scope: payment state is maintained by the platform, not by tenants.
  const [initial] = await withSystem(services.db, (tx) =>
    tx.select().from(payments).where(eq(payments.id, paymentId)),
  );
  if (!initial) throw new NotFoundError('Payment');
  if (!initial.providerPaymentId) {
    return { status: initial.status, changed: false, fulfilled: false };
  }
  const provider = services.providers.get(initial.provider);
  const remote = await provider.retrievePayment(initial.providerPaymentId);

  return withSystem(services.db, async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');
    if (!payment) throw new NotFoundError('Payment');
    const problem = mismatch(payment, remote);
    if (problem) {
      services.logger?.error(
        { paymentId, problem, provider: payment.provider },
        'provider payment does not match the expected payment; refusing to fulfil',
      );
      if (payment.status !== 'failed' && !isPaid(payment.status)) {
        await tx
          .update(payments)
          .set({ status: 'failed', failureCode: problem, lastVerifiedAt: new Date() })
          .where(eq(payments.id, payment.id));
        await tx
          .update(checkoutSessions)
          .set({ status: 'failed' })
          .where(eq(checkoutSessions.paymentId, payment.id));
      }
      return { status: 'failed', changed: true, fulfilled: false };
    }

    if (!canTransition(payment.status, remote.status) || payment.status === remote.status) {
      await tx
        .update(payments)
        .set({ lastVerifiedAt: new Date() })
        .where(eq(payments.id, payment.id));
      return { status: payment.status, changed: false, fulfilled: false };
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
      .where(eq(payments.id, payment.id));

    const [checkout] = await tx
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.paymentId, payment.id));

    let fulfilled = false;
    if (becamePaid) {
      if (payment.purpose === 'subscription' && checkout) {
        await fulfilSubscription(tx, payment, checkout, correlationId);
        fulfilled = true;
      }
      await emitEvent(tx, {
        type: 'payment.succeeded',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: { type: 'system', id: null },
        payload: {
          paymentId: payment.id,
          purpose: payment.purpose,
          amountMinor: String(payment.amountMinor),
          currency: payment.currency,
        },
        correlationId,
      });
    } else if (remote.status === 'failed' || remote.status === 'canceled') {
      if (checkout?.status === 'open') {
        await tx
          .update(checkoutSessions)
          .set({ status: 'failed' })
          .where(eq(checkoutSessions.id, checkout.id));
      }
      await emitEvent(tx, {
        type: 'payment.failed',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: { type: 'system', id: null },
        payload: {
          paymentId: payment.id,
          purpose: payment.purpose,
          failureCode: remote.failureCode,
        },
        correlationId,
      });
    } else if (remote.status === 'refunded' || remote.status === 'partially_refunded') {
      await emitEvent(tx, {
        type: 'payment.refunded',
        organizationId: payment.organizationId,
        subject: { type: 'payment', id: payment.id },
        actor: { type: 'system', id: null },
        payload: {
          paymentId: payment.id,
          refundedMinor: String(remote.refunded.amountMinor),
          currency: payment.currency,
        },
        correlationId,
      });
    }
    return { status: remote.status, changed: true, fulfilled };
  });
}

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate';

function fingerprint(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex').slice(0, 40);
}

/**
 * Handles an inbound provider webhook: authenticate → record (unique per provider event, which
 * gives replay protection and idempotency) → resolve the payment → re-fetch and sync. The
 * webhook's own status is never trusted.
 */
export async function handlePaymentWebhook(
  services: PaymentServices,
  providerName: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  correlationId?: string,
): Promise<WebhookOutcome> {
  if (!services.providers.has(providerName)) throw new NotFoundError('Webhook endpoint');
  const provider = services.providers.get(providerName);

  let event;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch (error) {
    // System scope: webhook diagnostics are platform-level.
    await withSystem(services.db, (tx) =>
      tx
        .insert(paymentWebhookEvents)
        .values({
          provider: providerName,
          providerEventId: `invalid:${fingerprint(rawBody)}`,
          signatureValid: false,
          status: 'rejected',
          error: error instanceof WebhookSignatureError ? 'invalid signature' : 'malformed payload',
        })
        .onConflictDoNothing(),
    );
    throw new UnauthenticatedError('Invalid webhook signature');
  }

  if (event === null) return 'ignored';

  const inserted = await withSystem(services.db, (tx) =>
    tx
      .insert(paymentWebhookEvents)
      .values({
        provider: providerName,
        providerEventId: event.providerEventId.slice(0, 300),
        signatureValid: true,
        providerPaymentId: event.providerPaymentId,
        payload: redactSensitive(event.raw) as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id }),
  );
  const record = inserted[0];
  if (!record) return 'duplicate';

  const [payment] = await withSystem(services.db, (tx) =>
    tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.provider, providerName),
          eq(payments.providerPaymentId, event.providerPaymentId),
        ),
      ),
  );
  if (!payment) {
    await withSystem(services.db, (tx) =>
      tx
        .update(paymentWebhookEvents)
        .set({ status: 'ignored', error: 'unknown payment', processedAt: new Date() })
        .where(eq(paymentWebhookEvents.id, record.id)),
    );
    services.logger?.warn({ provider: providerName }, 'webhook for unknown payment ignored');
    return 'ignored';
  }

  try {
    await syncPayment(services, payment.id, correlationId);
    await withSystem(services.db, (tx) =>
      tx
        .update(paymentWebhookEvents)
        .set({
          status: 'processed',
          organizationId: payment.organizationId,
          processedAt: new Date(),
        })
        .where(eq(paymentWebhookEvents.id, record.id)),
    );
    return 'processed';
  } catch (error) {
    // Allow the provider's retry to process it again.
    await withSystem(services.db, (tx) =>
      tx.delete(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, record.id)),
    );
    throw error;
  }
}

/** Checkout status for the tenant's return page (tenant scope read). */
export async function getCheckout(
  db: Database,
  scope: { organizationId: string; userId: string },
  checkoutId: string,
): Promise<{ checkout: CheckoutSession; payment: Payment }> {
  return withTenant(db, scope, async (tx) => {
    const [row] = await tx
      .select({ checkout: checkoutSessions, payment: payments })
      .from(checkoutSessions)
      .innerJoin(payments, eq(payments.id, checkoutSessions.paymentId))
      .where(
        and(
          eq(checkoutSessions.id, checkoutId),
          eq(checkoutSessions.organizationId, scope.organizationId),
        ),
      );
    if (!row) throw new NotFoundError('Checkout');
    return row;
  });
}

export async function listPayments(
  db: Database,
  scope: { organizationId: string; userId: string },
): Promise<Payment[]> {
  return withTenant(db, scope, (tx) =>
    tx
      .select()
      .from(payments)
      .where(eq(payments.organizationId, scope.organizationId))
      .orderBy(desc(payments.createdAt))
      .limit(100),
  );
}

const GRACE_PERIOD_MS = 7 * 24 * 3600 * 1000;

/**
 * Periodic subscription upkeep (worker job): paid periods that ended move to past_due, past_due
 * beyond the grace period is paused, cancel-at-period-end is applied, stale checkouts expire.
 */
export async function runSubscriptionMaintenance(
  db: Database,
  now: Date = new Date(),
): Promise<{
  pastDue: number;
  paused: number;
  canceled: number;
  expiredCheckouts: number;
}> {
  // System scope: platform maintenance across all organizations.
  return withSystem(db, async (tx) => {
    const ended = await tx
      .update(subscriptions)
      .set({ status: 'canceled', canceledAt: now })
      .where(
        and(
          eq(subscriptions.cancelAtPeriodEnd, true),
          sql`${subscriptions.status} <> 'canceled'`,
          lt(subscriptions.currentPeriodEnd, now),
        ),
      )
      .returning({ id: subscriptions.id, organizationId: subscriptions.organizationId });
    const pastDue = await tx
      .update(subscriptions)
      .set({ status: 'past_due' })
      .where(
        and(
          sql`${subscriptions.status} in ('active', 'trialing')`,
          sql`${subscriptions.provider} <> 'manual'`,
          lt(subscriptions.currentPeriodEnd, now),
        ),
      )
      .returning({ id: subscriptions.id, organizationId: subscriptions.organizationId });
    const paused = await tx
      .update(subscriptions)
      .set({ status: 'paused' })
      .where(
        and(
          eq(subscriptions.status, 'past_due'),
          lt(subscriptions.currentPeriodEnd, new Date(now.getTime() - GRACE_PERIOD_MS)),
        ),
      )
      .returning({ id: subscriptions.id, organizationId: subscriptions.organizationId });
    const expired = await tx
      .update(checkoutSessions)
      .set({ status: 'expired' })
      .where(and(eq(checkoutSessions.status, 'open'), lt(checkoutSessions.expiresAt, now)))
      .returning({ id: checkoutSessions.id });
    for (const [rows, type] of [
      [ended, 'subscription.canceled_at_period_end'],
      [pastDue, 'subscription.past_due'],
      [paused, 'subscription.paused'],
    ] as const) {
      for (const row of rows) {
        await tx
          .insert(billingEvents)
          .values({ organizationId: row.organizationId, type, data: { subscriptionId: row.id } });
      }
    }
    return {
      pastDue: pastDue.length,
      paused: paused.length,
      canceled: ended.length,
      expiredCheckouts: expired.length,
    };
  });
}
