import type { TenantTx } from '@businessos/database';
import { z } from 'zod';
import { listCompanies } from './companies';
import { listContacts } from './contacts';
import { canRead, type CrmContext } from './context';
import { listDeals } from './deals';

export const globalSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) });

export interface SearchHit {
  type: 'contact' | 'company' | 'deal';
  id: string;
  title: string;
  subtitle: string | null;
}

/**
 * Cross-record CRM search. Only record types the caller may read are searched, so results never
 * reveal records the caller could not open.
 */
export async function searchCrm(
  tx: TenantTx,
  ctx: CrmContext,
  q: string,
  perType = 5,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  if (canRead(ctx, 'contact')) {
    const page = await listContacts(tx, ctx, { q, limit: perType, sort: 'updated_desc' });
    hits.push(
      ...page.data.map((c) => ({
        type: 'contact' as const,
        id: c.id,
        title: c.displayName,
        subtitle: c.email ?? c.phone ?? c.primaryCompany?.name ?? null,
      })),
    );
  }
  if (canRead(ctx, 'company')) {
    const page = await listCompanies(tx, ctx, { q, limit: perType, sort: 'updated_desc' });
    hits.push(
      ...page.data.map((c) => ({
        type: 'company' as const,
        id: c.id,
        title: c.name,
        subtitle: c.domain,
      })),
    );
  }
  if (canRead(ctx, 'deal')) {
    const page = await listDeals(tx, ctx, { q, limit: perType, sort: 'updated_desc' });
    hits.push(
      ...page.data.map((d) => ({
        type: 'deal' as const,
        id: d.id,
        title: d.name,
        subtitle: `${d.pipelineName} · ${d.stageName}`,
      })),
    );
  }
  return hits;
}
