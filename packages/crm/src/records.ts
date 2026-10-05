import { crmCompanies, crmContacts, crmDeals, type TenantTx } from '@businessos/database';
import { ValidationError } from '@businessos/shared';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Reference checks for ids supplied by clients. Composite foreign keys already stop
 * cross-tenant references at the database; these add "exists and not deleted" with a clean
 * validation error instead of a constraint violation.
 */
export async function assertContactExists(
  tx: TenantTx,
  organizationId: string,
  id: string,
  path = 'contactId',
): Promise<void> {
  const [row] = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.id, id),
        eq(crmContacts.organizationId, organizationId),
        isNull(crmContacts.deletedAt),
      ),
    );
  if (!row) throw new ValidationError('Unknown contact', [{ path, message: 'Contact not found' }]);
}

export async function assertCompanyExists(
  tx: TenantTx,
  organizationId: string,
  id: string,
  path = 'companyId',
): Promise<void> {
  const [row] = await tx
    .select({ id: crmCompanies.id })
    .from(crmCompanies)
    .where(
      and(
        eq(crmCompanies.id, id),
        eq(crmCompanies.organizationId, organizationId),
        isNull(crmCompanies.deletedAt),
      ),
    );
  if (!row) throw new ValidationError('Unknown company', [{ path, message: 'Company not found' }]);
}

export async function assertDealExists(
  tx: TenantTx,
  organizationId: string,
  id: string,
  path = 'dealId',
): Promise<void> {
  const [row] = await tx
    .select({ id: crmDeals.id })
    .from(crmDeals)
    .where(
      and(
        eq(crmDeals.id, id),
        eq(crmDeals.organizationId, organizationId),
        isNull(crmDeals.deletedAt),
      ),
    );
  if (!row) throw new ValidationError('Unknown deal', [{ path, message: 'Deal not found' }]);
}

/** Bulk operations take at most this many ids. */
export const MAX_BULK_IDS = 500;
