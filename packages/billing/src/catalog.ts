import {
  planEntitlements,
  planVersions,
  plans,
  prices,
  type BillingInterval,
  type Plan,
  type PlanVersion,
  type Price,
  type SystemTx,
  type Tx,
} from '@businessos/database';
import {
  ConflictError,
  isCurrencyCode,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type CurrencyCode,
} from '@businessos/shared';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import {
  decodeEntitlementValue,
  encodeEntitlementValue,
  isEntitlementKey,
  parseEntitlementValue,
  type EntitlementKey,
  type EntitlementValue,
} from './entitlements';

/*
 * Plan catalogue management. Writes require system scope (platform administration, seeds).
 */

export async function createPlan(
  tx: SystemTx,
  input: {
    key: string;
    name: string;
    description?: string;
    isPublic?: boolean;
    isDefault?: boolean;
    sortOrder?: number;
  },
): Promise<Plan> {
  if (input.isDefault) {
    await tx.update(plans).set({ isDefault: false }).where(eq(plans.isDefault, true));
  }
  const [plan] = await tx
    .insert(plans)
    .values({
      key: input.key,
      name: input.name,
      description: input.description ?? '',
      isPublic: input.isPublic ?? true,
      isDefault: input.isDefault ?? false,
      sortOrder: input.sortOrder ?? 0,
    })
    .onConflictDoNothing({ target: plans.key })
    .returning();
  if (!plan) throw new ConflictError(`Plan ${input.key} already exists`);
  return plan;
}

function validateEntitlements(
  values: Record<string, unknown>,
): { key: EntitlementKey; value: EntitlementValue }[] {
  const issues: { path: string; message: string }[] = [];
  const parsed: { key: EntitlementKey; value: EntitlementValue }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!isEntitlementKey(key)) {
      issues.push({ path: key, message: 'Unknown entitlement' });
      continue;
    }
    try {
      parsed.push({ key, value: parseEntitlementValue(key, value) });
    } catch {
      issues.push({ path: key, message: 'Invalid value for this entitlement' });
    }
  }
  if (issues.length > 0) throw new ValidationError('Invalid entitlements', issues);
  return parsed;
}

/** Creates the next draft version of a plan with its entitlement values. */
export async function createPlanVersion(
  tx: SystemTx,
  planId: string,
  entitlements: Record<string, unknown>,
): Promise<PlanVersion> {
  const values = validateEntitlements(entitlements);
  const [current] = await tx
    .select({ latest: max(planVersions.version) })
    .from(planVersions)
    .where(eq(planVersions.planId, planId));
  const [version] = await tx
    .insert(planVersions)
    .values({ planId, version: (current?.latest ?? 0) + 1, status: 'draft' })
    .returning();
  if (!version) throw new Error('plan version insert returned no row');
  if (values.length > 0) {
    await tx.insert(planEntitlements).values(
      values.map(({ key, value }) => ({
        planVersionId: version.id,
        key,
        value: encodeEntitlementValue(value),
      })),
    );
  }
  return version;
}

export async function addPrice(
  tx: SystemTx,
  planVersionId: string,
  input: { currency: CurrencyCode; interval: BillingInterval; amountMinor: bigint },
): Promise<Price> {
  if (!isCurrencyCode(input.currency)) throw new ValidationError('Unsupported currency');
  if (input.amountMinor < 0n) throw new ValidationError('Price cannot be negative');
  const [price] = await tx
    .insert(prices)
    .values({ planVersionId, ...input })
    .returning();
  if (!price) throw new Error('price insert returned no row');
  return price;
}

/** Publishes a draft version; it becomes the version new subscriptions use. */
export async function publishPlanVersion(
  tx: SystemTx,
  planVersionId: string,
): Promise<PlanVersion> {
  const [version] = await tx
    .update(planVersions)
    .set({ status: 'published', publishedAt: new Date() })
    .where(and(eq(planVersions.id, planVersionId), eq(planVersions.status, 'draft')))
    .returning();
  if (!version) throw new UnprocessableError('Only draft versions can be published');
  return version;
}

/** Latest published version of a plan, if any. */
export async function latestPublishedVersion(tx: Tx, planId: string): Promise<PlanVersion | null> {
  const [version] = await tx
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.planId, planId), eq(planVersions.status, 'published')))
    .orderBy(desc(planVersions.version))
    .limit(1);
  return version ?? null;
}

export interface CatalogPlan {
  id: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  versionId: string;
  version: number;
  entitlements: Record<string, unknown>;
  prices: { id: string; currency: string; interval: BillingInterval; amountMinor: bigint }[];
}

/** Public, active plans with their latest published version (readable from any scope). */
export async function listPublicPlans(tx: Tx): Promise<CatalogPlan[]> {
  const rows = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.status, 'active'), eq(plans.isPublic, true)))
    .orderBy(asc(plans.sortOrder), asc(plans.name))
    .limit(50);
  const result: CatalogPlan[] = [];
  for (const plan of rows) {
    const version = await latestPublishedVersion(tx, plan.id);
    if (!version) continue;
    result.push(await describeVersion(tx, plan, version));
  }
  return result;
}

export async function describeVersion(
  tx: Tx,
  plan: Plan,
  version: PlanVersion,
): Promise<CatalogPlan> {
  const [entitlementRows, priceRows] = await Promise.all([
    tx.select().from(planEntitlements).where(eq(planEntitlements.planVersionId, version.id)),
    tx
      .select()
      .from(prices)
      .where(and(eq(prices.planVersionId, version.id), eq(prices.status, 'active')))
      .orderBy(asc(prices.currency), asc(prices.interval)),
  ]);
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    isDefault: plan.isDefault,
    versionId: version.id,
    version: version.version,
    entitlements: Object.fromEntries(
      entitlementRows.flatMap((row) => {
        if (!isEntitlementKey(row.key)) return [];
        try {
          return [[row.key, decodeEntitlementValue(row.key, row.value)]];
        } catch {
          return [];
        }
      }),
    ),
    prices: priceRows.map((price) => ({
      id: price.id,
      currency: price.currency,
      interval: price.interval,
      amountMinor: price.amountMinor,
    })),
  };
}

export async function getPlanVersionWithPlan(
  tx: Tx,
  planVersionId: string,
): Promise<{ plan: Plan; version: PlanVersion }> {
  const [row] = await tx
    .select({ plan: plans, version: planVersions })
    .from(planVersions)
    .innerJoin(plans, eq(plans.id, planVersions.planId))
    .where(eq(planVersions.id, planVersionId));
  if (!row) throw new NotFoundError('Plan version');
  return row;
}

export async function entitlementsForVersions(
  tx: Tx,
  versionIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (versionIds.length === 0) return result;
  const rows = await tx
    .select()
    .from(planEntitlements)
    .where(inArray(planEntitlements.planVersionId, versionIds));
  for (const row of rows) {
    const values = result.get(row.planVersionId) ?? {};
    values[row.key] = row.value;
    result.set(row.planVersionId, values);
  }
  return result;
}
