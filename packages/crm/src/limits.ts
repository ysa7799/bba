import { assertWithinLimit, getLimit } from '@businessos/billing';
import { crmContacts, crmPipelines, type TenantTx } from '@businessos/database';
import { and, count, eq, isNull, sql } from 'drizzle-orm';

async function lock(tx: TenantTx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Enforces `crm.contacts.max` for `adding` new contacts. A per-organization transaction lock
 * serializes concurrent creates so parallel requests cannot overshoot the limit.
 */
export async function assertContactCapacity(
  tx: TenantTx,
  organizationId: string,
  adding: number,
): Promise<void> {
  const limit = await getLimit(tx, organizationId, 'crm.contacts.max');
  if (limit === null) return;
  await lock(tx, `crm.contacts:${organizationId}`);
  const [row] = await tx
    .select({ n: count() })
    .from(crmContacts)
    .where(and(eq(crmContacts.organizationId, organizationId), isNull(crmContacts.deletedAt)));
  await assertWithinLimit(tx, organizationId, 'crm.contacts.max', (row?.n ?? 0) + adding);
}

/** Enforces `crm.pipelines.max` (active pipelines). */
export async function assertPipelineCapacity(tx: TenantTx, organizationId: string): Promise<void> {
  await lock(tx, `crm.pipelines:${organizationId}`);
  const [row] = await tx
    .select({ n: count() })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.organizationId, organizationId), isNull(crmPipelines.archivedAt)));
  await assertWithinLimit(tx, organizationId, 'crm.pipelines.max', (row?.n ?? 0) + 1);
}

export async function lockPipelines(tx: TenantTx, organizationId: string): Promise<void> {
  await lock(tx, `crm.pipelines:${organizationId}`);
}
