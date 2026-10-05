import {
  invitations,
  memberships,
  organizations,
  usageCounters,
  usageRecords,
  type Tx,
} from '@businessos/database';
import { EntitlementExceededError, NotFoundError } from '@businessos/shared';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { ENTITLEMENTS, type QuotaKey } from './entitlements';
import { monthPeriodStart } from './period';
import { assertWithinLimit, getLimit } from './resolve';

async function organizationTimezone(tx: Tx, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!row) throw new NotFoundError('Organization');
  return row.timezone;
}

export interface QuotaUsage {
  key: QuotaKey;
  periodStart: string;
  used: number;
  limit: number | null;
  remaining: number | null;
}

export async function getQuotaUsage(
  tx: Tx,
  organizationId: string,
  key: QuotaKey,
  at: Date = new Date(),
): Promise<QuotaUsage> {
  const periodStart = monthPeriodStart(at, await organizationTimezone(tx, organizationId));
  const [counter] = await tx
    .select({ used: usageCounters.used })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, organizationId),
        eq(usageCounters.metric, key),
        eq(usageCounters.periodStart, periodStart),
      ),
    );
  const used = Number(counter?.used ?? 0n);
  const limit = await getLimit(tx, organizationId, key);
  return {
    key,
    periodStart,
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
}

/** Non-mutating pre-check (e.g. to warn before a bulk send). */
export async function checkUsage(
  tx: Tx,
  organizationId: string,
  key: QuotaKey,
  amount: number,
): Promise<QuotaUsage & { allowed: boolean }> {
  const usage = await getQuotaUsage(tx, organizationId, key);
  return { ...usage, allowed: usage.limit === null || usage.used + amount <= usage.limit };
}

/**
 * Atomically consumes quota for the current period. Concurrency-safe: the increment is a
 * single conditional UPDATE, so parallel requests can never push usage past the limit.
 * With an idempotency key, retries of the same operation consume once. Throws
 * `EntitlementExceededError` (402) when the quota would be exceeded; because this runs inside
 * the caller's transaction, the rejected operation leaves no partial state.
 */
export async function consumeUsage(
  tx: Tx,
  organizationId: string,
  key: QuotaKey,
  amount: number,
  options: { idempotencyKey?: string; source?: string; at?: Date } = {},
): Promise<QuotaUsage> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Usage amount must be a positive integer');
  }
  const at = options.at ?? new Date();
  const periodStart = monthPeriodStart(at, await organizationTimezone(tx, organizationId));
  const limit = await getLimit(tx, organizationId, key);

  if (options.idempotencyKey) {
    const inserted = await tx
      .insert(usageRecords)
      .values({
        organizationId,
        metric: key,
        periodStart,
        quantity: BigInt(amount),
        idempotencyKey: options.idempotencyKey.slice(0, 200),
        source: options.source ?? null,
        occurredAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: usageRecords.id });
    if (inserted.length === 0) {
      // Already consumed by an earlier attempt of the same operation.
      return getQuotaUsage(tx, organizationId, key, at);
    }
  } else {
    await tx.insert(usageRecords).values({
      organizationId,
      metric: key,
      periodStart,
      quantity: BigInt(amount),
      source: options.source ?? null,
      occurredAt: at,
    });
  }

  await tx
    .insert(usageCounters)
    .values({ organizationId, metric: key, periodStart, used: 0n })
    .onConflictDoNothing();

  const increment = BigInt(amount);
  const conditions = [
    eq(usageCounters.organizationId, organizationId),
    eq(usageCounters.metric, key),
    eq(usageCounters.periodStart, periodStart),
  ];
  if (limit !== null) {
    conditions.push(sql`${usageCounters.used} + ${increment} <= ${BigInt(limit)}`);
  }
  const [updated] = await tx
    .update(usageCounters)
    .set({ used: sql`${usageCounters.used} + ${increment}`, updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ used: usageCounters.used });
  if (!updated) {
    throw new EntitlementExceededError(
      key,
      `Monthly limit reached (${ENTITLEMENTS[key].description.toLowerCase()})`,
    );
  }
  const used = Number(updated.used);
  return {
    key,
    periodStart,
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
}

/**
 * Seats in use: active members plus pending, unexpired invitations. Locks the organization
 * row so concurrent invitations/joins are serialized against the `users.max` limit.
 */
export async function seatUsage(tx: Tx, organizationId: string): Promise<number> {
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');
  const [members] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, 'active')));
  const [pending] = await tx
    .select({ n: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, sql`now()`),
      ),
    );
  return (members?.n ?? 0) + (pending?.n ?? 0);
}

/** Throws 402 when adding `adding` seats would exceed `users.max`. */
export async function assertSeatsAvailable(
  tx: Tx,
  organizationId: string,
  adding: number,
): Promise<void> {
  const used = await seatUsage(tx, organizationId);
  await assertWithinLimit(tx, organizationId, 'users.max', used + adding);
}
