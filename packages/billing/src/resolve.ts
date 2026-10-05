import { entitlementOverrides, type Tx } from '@businessos/database';
import { EntitlementExceededError } from '@businessos/shared';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { entitlementsForVersions } from './catalog';
import {
  ENTITLEMENTS,
  fallbackEntitlements,
  decodeEntitlementValue,
  isEntitlementKey,
  type EntitlementKey,
  type EntitlementValue,
  type FeatureKey,
  type LimitKey,
} from './entitlements';
import { ENTITLED_STATUSES, getLiveSubscription } from './subscriptions';

export type EntitlementSource = 'plan' | 'override' | 'fallback';

export interface ResolvedEntitlements {
  values: Record<EntitlementKey, EntitlementValue>;
  sources: Record<EntitlementKey, EntitlementSource>;
  subscriptionId: string | null;
  planVersionId: string | null;
}

/**
 * Resolves an organization's entitlements: override > plan (live, entitled subscription) >
 * fallback baseline. Payment providers never enter this calculation; only subscription state
 * (changed by verified provider events or administrators) does.
 */
export async function resolveEntitlements(
  tx: Tx,
  organizationId: string,
): Promise<ResolvedEntitlements> {
  const values = fallbackEntitlements();
  const sources = Object.fromEntries(Object.keys(values).map((key) => [key, 'fallback'])) as Record<
    EntitlementKey,
    EntitlementSource
  >;

  const subscription = await getLiveSubscription(tx, organizationId);
  const entitled = subscription !== null && ENTITLED_STATUSES.includes(subscription.status);
  if (entitled) {
    const planValues =
      (await entitlementsForVersions(tx, [subscription.planVersionId])).get(
        subscription.planVersionId,
      ) ?? {};
    for (const [key, raw] of Object.entries(planValues)) {
      if (!isEntitlementKey(key)) continue;
      try {
        values[key] = decodeEntitlementValue(key, raw);
        sources[key] = 'plan';
      } catch {
        // Invalid stored value: keep the fallback rather than granting something unexpected.
      }
    }
  }

  const overrides = await tx
    .select()
    .from(entitlementOverrides)
    .where(
      and(
        eq(entitlementOverrides.organizationId, organizationId),
        or(isNull(entitlementOverrides.expiresAt), gt(entitlementOverrides.expiresAt, sql`now()`)),
      ),
    );
  for (const override of overrides) {
    if (!isEntitlementKey(override.key)) continue;
    try {
      values[override.key] = decodeEntitlementValue(override.key, override.value);
      sources[override.key] = 'override';
    } catch {
      // Ignore malformed overrides.
    }
  }

  return {
    values,
    sources,
    subscriptionId: entitled ? subscription.id : null,
    planVersionId: entitled ? subscription.planVersionId : null,
  };
}

export async function canUseFeature(
  tx: Tx,
  organizationId: string,
  key: FeatureKey,
): Promise<boolean> {
  const resolved = await resolveEntitlements(tx, organizationId);
  return resolved.values[key] === true;
}

/** Alias kept for readability at call sites that phrase it as "has entitlement". */
export const hasEntitlement = canUseFeature;

/** Throws 402 `entitlement_exceeded` when the feature is not in the organization's plan. */
export async function requireFeature(
  tx: Tx,
  organizationId: string,
  key: FeatureKey,
): Promise<void> {
  if (!(await canUseFeature(tx, organizationId, key))) {
    throw new EntitlementExceededError(
      key,
      `Your plan does not include ${ENTITLEMENTS[key].description.toLowerCase()}`,
    );
  }
}

/** Numeric limit for a limit/quota key; null means unlimited. */
export async function getLimit(
  tx: Tx,
  organizationId: string,
  key: LimitKey,
): Promise<number | null> {
  const value = (await resolveEntitlements(tx, organizationId)).values[key];
  return typeof value === 'number' ? value : null;
}

/**
 * For "limit" entitlements measured by counting rows (members, contacts, pipelines…): throws
 * when `projectedTotal` would exceed the limit. Callers lock the relevant parent row first so
 * concurrent requests cannot both pass.
 */
export async function assertWithinLimit(
  tx: Tx,
  organizationId: string,
  key: LimitKey,
  projectedTotal: number,
): Promise<void> {
  const limit = await getLimit(tx, organizationId, key);
  if (limit !== null && projectedTotal > limit) {
    throw new EntitlementExceededError(
      key,
      `Your plan allows up to ${limit} (${ENTITLEMENTS[key].description.toLowerCase()})`,
    );
  }
}
