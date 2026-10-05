import {
  billingEvents,
  plans,
  subscriptions,
  type Subscription,
  type SystemTx,
  type Tx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import { NotFoundError, UnprocessableError } from '@businessos/shared';
import { and, eq, ne } from 'drizzle-orm';
import { getPlanVersionWithPlan, latestPublishedVersion } from './catalog';

/** Statuses that grant the plan's entitlements (past_due keeps access during dunning). */
export const ENTITLED_STATUSES: readonly Subscription['status'][] = [
  'trialing',
  'active',
  'past_due',
];

export async function getLiveSubscription(
  tx: Tx,
  organizationId: string,
): Promise<Subscription | null> {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.organizationId, organizationId), ne(subscriptions.status, 'canceled')),
    );
  return row ?? null;
}

async function recordBillingEvent(
  tx: SystemTx,
  organizationId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.insert(billingEvents).values({ organizationId, type, data });
}

/**
 * Subscribes an organization to the default plan's latest published version (free/manual).
 * No-op when no default plan is configured or a live subscription already exists.
 */
export async function subscribeToDefaultPlan(
  tx: SystemTx,
  organizationId: string,
  correlationId?: string,
): Promise<Subscription | null> {
  if (await getLiveSubscription(tx, organizationId)) return null;
  const [plan] = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.isDefault, true), eq(plans.status, 'active')));
  if (!plan) return null;
  const version = await latestPublishedVersion(tx, plan.id);
  if (!version) return null;
  return startSubscription(tx, {
    organizationId,
    planVersionId: version.id,
    status: 'active',
    provider: 'manual',
    correlationId,
  });
}

export async function startSubscription(
  tx: SystemTx,
  input: {
    organizationId: string;
    planVersionId: string;
    status: Subscription['status'];
    provider: string;
    providerSubscriptionId?: string | null;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date | null;
    trialEndsAt?: Date | null;
    correlationId?: string | undefined;
  },
): Promise<Subscription> {
  const { version } = await getPlanVersionWithPlan(tx, input.planVersionId);
  if (version.status !== 'published') {
    throw new UnprocessableError('Subscriptions can only use published plan versions');
  }
  const [subscription] = await tx
    .insert(subscriptions)
    .values({
      organizationId: input.organizationId,
      planVersionId: input.planVersionId,
      status: input.status,
      provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      currentPeriodStart: input.currentPeriodStart ?? new Date(),
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
    })
    .returning();
  if (!subscription) throw new Error('subscription insert returned no row');
  await recordBillingEvent(tx, input.organizationId, 'subscription.started', {
    subscriptionId: subscription.id,
    planVersionId: input.planVersionId,
    status: input.status,
    provider: input.provider,
  });
  await emitEvent(tx, {
    type: 'subscription.started',
    organizationId: input.organizationId,
    subject: { type: 'subscription', id: subscription.id },
    actor: { type: 'system', id: null },
    payload: { subscriptionId: subscription.id, planVersionId: input.planVersionId },
    correlationId: input.correlationId,
  });
  return subscription;
}

/** Moves the live subscription to another published plan version (upgrade/downgrade). */
export async function changeSubscriptionPlan(
  tx: SystemTx,
  organizationId: string,
  planVersionId: string,
  correlationId?: string,
): Promise<Subscription> {
  const current = await getLiveSubscription(tx, organizationId);
  if (!current) throw new NotFoundError('Subscription');
  const { version } = await getPlanVersionWithPlan(tx, planVersionId);
  if (version.status !== 'published') {
    throw new UnprocessableError('Subscriptions can only use published plan versions');
  }
  const [updated] = await tx
    .update(subscriptions)
    .set({ planVersionId })
    .where(eq(subscriptions.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError('Subscription');
  await recordBillingEvent(tx, organizationId, 'subscription.plan_changed', {
    subscriptionId: current.id,
    from: current.planVersionId,
    to: planVersionId,
  });
  await emitEvent(tx, {
    type: 'subscription.changed',
    organizationId,
    subject: { type: 'subscription', id: current.id },
    actor: { type: 'system', id: null },
    payload: {
      subscriptionId: current.id,
      fromPlanVersionId: current.planVersionId,
      toPlanVersionId: planVersionId,
      status: updated.status,
    },
    correlationId,
  });
  return updated;
}

export async function setSubscriptionStatus(
  tx: SystemTx,
  organizationId: string,
  status: Exclude<Subscription['status'], 'canceled'>,
  correlationId?: string,
): Promise<Subscription> {
  const current = await getLiveSubscription(tx, organizationId);
  if (!current) throw new NotFoundError('Subscription');
  const [updated] = await tx
    .update(subscriptions)
    .set({ status })
    .where(eq(subscriptions.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError('Subscription');
  await recordBillingEvent(tx, organizationId, 'subscription.status_changed', {
    subscriptionId: current.id,
    from: current.status,
    to: status,
  });
  await emitEvent(tx, {
    type: 'subscription.changed',
    organizationId,
    subject: { type: 'subscription', id: current.id },
    actor: { type: 'system', id: null },
    payload: {
      subscriptionId: current.id,
      fromPlanVersionId: current.planVersionId,
      toPlanVersionId: current.planVersionId,
      status,
    },
    correlationId,
  });
  return updated;
}

export async function cancelSubscription(
  tx: SystemTx,
  organizationId: string,
  options: { atPeriodEnd: boolean; correlationId?: string },
): Promise<Subscription> {
  const current = await getLiveSubscription(tx, organizationId);
  if (!current) throw new NotFoundError('Subscription');
  const [updated] = await tx
    .update(subscriptions)
    .set(
      options.atPeriodEnd
        ? { cancelAtPeriodEnd: true }
        : { status: 'canceled', canceledAt: new Date(), cancelAtPeriodEnd: false },
    )
    .where(eq(subscriptions.id, current.id))
    .returning();
  if (!updated) throw new NotFoundError('Subscription');
  await recordBillingEvent(tx, organizationId, 'subscription.canceled', {
    subscriptionId: current.id,
    atPeriodEnd: options.atPeriodEnd,
  });
  if (!options.atPeriodEnd) {
    await emitEvent(tx, {
      type: 'subscription.canceled',
      organizationId,
      subject: { type: 'subscription', id: current.id },
      actor: { type: 'system', id: null },
      payload: { subscriptionId: current.id },
      correlationId: options.correlationId,
    });
  }
  return updated;
}
