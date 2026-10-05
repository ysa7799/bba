import {
  ENTITLEMENTS,
  describeVersion,
  getLiveSubscription,
  getPlanVersionWithPlan,
  getQuotaUsage,
  listPublicPlans,
  resolveEntitlements,
  seatUsage,
  type CatalogPlan,
  type EntitlementKey,
  type QuotaKey,
} from '@businessos/billing';
import { recordAudit } from '@businessos/audit';
import { billingCustomers, withTenant, withUser } from '@businessos/database';
import { isCurrencyCode, money, toMoneyJson } from '@businessos/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext } from '../../lib/http';
import { parseInput } from '../../lib/validation';
import { requireAuth } from '../../plugins/session';
import { requirePermission, requireTenant, resolveTenant, tenantScope } from '../../plugins/tenant';

function serializePlan(plan: CatalogPlan) {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    isDefault: plan.isDefault,
    version: plan.version,
    entitlements: plan.entitlements,
    prices: plan.prices.flatMap((price) =>
      isCurrencyCode(price.currency)
        ? [
            {
              id: price.id,
              interval: price.interval,
              ...toMoneyJson(money(price.amountMinor, price.currency)),
            },
          ]
        : [],
    ),
  };
}

const customerSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  billingEmail: z
    .string()
    .trim()
    .max(254)
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  taxId: z.string().trim().max(50).nullable().optional(),
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase()),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
});

/** `/app/billing/*` (user scope): the public plan catalogue. */
export function billingCatalogRoutes(app: FastifyInstance): void {
  app.get('/plans', async (request) => {
    const auth = requireAuth(request);
    const plans = await withUser(app.deps.db.db, auth.user.id, (tx) => listPublicPlans(tx));
    return { data: plans.map(serializePlan) };
  });
}

/** `/app/orgs/:orgId/billing/*`: entitlements, subscription and billing profile. */
export function organizationBillingRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    await resolveTenant(request);
  });

  // Any member can see what the plan allows (the UI uses it to show or hide features).
  app.get('/entitlements', async (request) => {
    const tenant = requireTenant(request);
    return withTenant(app.deps.db.db, tenantScope(tenant), async (tx) => {
      const resolved = await resolveEntitlements(tx, tenant.organizationId);
      const quotas: Record<string, unknown> = {};
      for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
        if (ENTITLEMENTS[key].kind === 'quota') {
          const usage = await getQuotaUsage(tx, tenant.organizationId, key as QuotaKey);
          quotas[key] = { used: usage.used, limit: usage.limit, periodStart: usage.periodStart };
        }
      }
      return {
        entitlements: resolved.values,
        sources: resolved.sources,
        usage: {
          'users.max': { used: await seatUsage(tx, tenant.organizationId) },
          ...quotas,
        },
      };
    });
  });

  app.get('/subscription', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    return withTenant(app.deps.db.db, tenantScope(tenant), async (tx) => {
      const subscription = await getLiveSubscription(tx, tenant.organizationId);
      if (!subscription) return { subscription: null, plan: null };
      const { plan, version } = await getPlanVersionWithPlan(tx, subscription.planVersionId);
      return {
        subscription: {
          id: subscription.id,
          status: subscription.status,
          provider: subscription.provider,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          trialEndsAt: subscription.trialEndsAt,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        },
        plan: serializePlan(await describeVersion(tx, plan, version)),
      };
    });
  });

  app.get('/customer', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    return withTenant(app.deps.db.db, tenantScope(tenant), async (tx) => {
      const [customer] = await tx
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.organizationId, tenant.organizationId));
      return { customer: customer ?? null };
    });
  });

  app.put('/customer', async (request) => {
    const tenant = requirePermission(request, 'settings.billing.manage');
    const input = parseInput(customerSchema, request.body);
    return withTenant(app.deps.db.db, tenantScope(tenant), async (tx) => {
      const values = {
        legalName: input.legalName,
        billingEmail: input.billingEmail,
        taxId: input.taxId ?? null,
        countryCode: input.countryCode,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        postalCode: input.postalCode ?? null,
      };
      const [customer] = await tx
        .insert(billingCustomers)
        .values({ organizationId: tenant.organizationId, ...values })
        .onConflictDoUpdate({ target: billingCustomers.organizationId, set: values })
        .returning();
      await recordAudit(tx, auditContext(request), {
        organizationId: tenant.organizationId,
        action: 'billing.profile_updated',
        target: { type: 'billing_customer', id: customer?.id ?? tenant.organizationId },
        metadata: { fields: Object.keys(input) },
      });
      return { customer };
    });
  });
}
