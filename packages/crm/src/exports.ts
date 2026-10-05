import {
  crmExports,
  crmImportRows,
  crmImports,
  EXPORT_ENTITIES,
  organizations,
  withSystem,
  withTenant,
  type CrmExport,
  type Database,
  type ExportEntity,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, NotFoundError } from '@businessos/shared';
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { companyListQuerySchema, listCompanies, type CompanySummary } from './companies';
import { contactListQuerySchema, listContacts, type ContactSummary } from './contacts';
import type { CrmContext } from './context';
import { toCsv } from './csv';
import { CustomFieldSet } from './custom-fields';
import { dealListQuerySchema, listDeals, type DealSummary } from './deals';

export const MAX_EXPORT_ROWS = 50_000;
export const EXPORT_TTL_HOURS = 24;
const MAX_ACTIVE_EXPORTS = 3;
const PAGE = 500;

const filtersFor = {
  contact: contactListQuerySchema.omit({ limit: true, cursor: true, sort: true }),
  company: companyListQuerySchema.omit({ limit: true, cursor: true, sort: true }),
  deal: dealListQuerySchema.omit({ limit: true, cursor: true, sort: true }),
} as const;

export const requestExportInputSchema = z.object({
  entityType: z.enum(EXPORT_ENTITIES),
  filters: z.record(z.string().max(80), z.string().max(200)).default({}),
});

export interface ExportSummary {
  id: string;
  entityType: ExportEntity;
  status: CrmExport['status'];
  rowCount: number | null;
  contentBytes: number | null;
  failureReason: string | null;
  downloadCount: number;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

function toSummary(row: CrmExport): ExportSummary {
  return {
    id: row.id,
    entityType: row.entityType,
    status: row.status,
    rowCount: row.rowCount,
    contentBytes: row.contentBytes,
    failureReason: row.failureReason,
    downloadCount: row.downloadCount,
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Splits `cf.<key>` filters from the rest (which each entity validates with its list schema). */
function splitFilters(raw: Record<string, unknown>) {
  const customFields: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('cf.')) customFields[key.slice(3)] = String(value);
    else rest[key] = value;
  }
  return { rest, customFields };
}

function validateFilters(entityType: ExportEntity, raw: Record<string, unknown>): void {
  filtersFor[entityType].parse(splitFilters(raw).rest);
}

export async function requestExport(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof requestExportInputSchema>,
): Promise<ExportSummary> {
  const input = requestExportInputSchema.parse(rawInput);
  if (ctx.actor.userId === null) throw new ConflictError('Exports belong to a user');
  validateFilters(input.entityType, input.filters);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`crm.exports:${ctx.organizationId}`}, 0))`,
  );
  const [active] = await tx
    .select({ n: count() })
    .from(crmExports)
    .where(
      and(
        eq(crmExports.organizationId, ctx.organizationId),
        inArray(crmExports.status, ['queued', 'processing']),
      ),
    );
  if ((active?.n ?? 0) >= MAX_ACTIVE_EXPORTS) {
    throw new ConflictError('Too many exports are running; wait for them to finish');
  }
  const [row] = await tx
    .insert(crmExports)
    .values({
      organizationId: ctx.organizationId,
      entityType: input.entityType,
      filters: input.filters,
      expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!row) throw new Error('export insert returned no row');
  return toSummary(row);
}

/** The requester's recent exports (exports are private to the member who asked for them). */
export async function listExports(tx: TenantTx, ctx: CrmContext): Promise<ExportSummary[]> {
  if (ctx.actor.userId === null) return [];
  const rows = await tx
    .select()
    .from(crmExports)
    .where(
      and(
        eq(crmExports.organizationId, ctx.organizationId),
        eq(crmExports.createdByUserId, ctx.actor.userId),
      ),
    )
    .orderBy(desc(crmExports.createdAt))
    .limit(20);
  return rows.map(toSummary);
}

async function ownExport(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  lock = false,
): Promise<CrmExport> {
  const query = tx
    .select()
    .from(crmExports)
    .where(
      and(
        eq(crmExports.id, id),
        eq(crmExports.organizationId, ctx.organizationId),
        eq(crmExports.createdByUserId, ctx.actor.userId ?? '00000000-0000-0000-0000-000000000000'),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Export');
  return row;
}

export async function getExport(tx: TenantTx, ctx: CrmContext, id: string): Promise<ExportSummary> {
  return toSummary(await ownExport(tx, ctx, id));
}

/** Returns the file for its creator while it is ready and unexpired, counting the download. */
export async function downloadExport(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ fileName: string; content: string; summary: ExportSummary }> {
  const row = await ownExport(tx, ctx, id, true);
  if (row.status === 'expired' || row.expiresAt.getTime() <= Date.now())
    throw new NotFoundError('Export');
  if (row.status !== 'completed' || row.content === null)
    throw new ConflictError('The export is not ready yet');
  const [updated] = await tx
    .update(crmExports)
    .set({ downloadCount: sql`${crmExports.downloadCount} + 1` })
    .where(eq(crmExports.id, id))
    .returning();
  const stamp = row.createdAt.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return {
    fileName: `${row.entityType === 'company' ? 'companies' : `${row.entityType}s`}-${stamp}.csv`,
    content: row.content,
    summary: toSummary(updated ?? row),
  };
}

type Cell = string | number | boolean | null;

function customCells(fields: CustomFieldSet, values: Record<string, unknown>): Cell[] {
  return fields.active().map((field) => {
    const value = values[field.key];
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.join('; ');
    return typeof value === 'object' ? JSON.stringify(value) : (value as Cell);
  });
}

async function collect<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ data: T[]; nextCursor: string | null }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.data);
    if (rows.length > MAX_EXPORT_ROWS) return null;
    if (!page.nextCursor) return rows;
    cursor = page.nextCursor;
  }
}

async function buildCsv(
  tx: TenantTx,
  ctx: CrmContext,
  row: CrmExport,
): Promise<{ csv: string; rows: number } | null> {
  const { rest, customFields } = splitFilters(row.filters);
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, row.entityType);
  const customHeaders = fields.active().map((field) => `cf:${field.key}`);
  switch (row.entityType) {
    case 'contact': {
      const filters = { ...filtersFor.contact.parse(rest), customFields };
      const contacts = await collect<ContactSummary>((cursor) =>
        listContacts(tx, ctx, {
          ...filters,
          limit: PAGE,
          cursor,
          sort: 'created_asc',
        }),
      );
      if (!contacts) return null;
      return {
        rows: contacts.length,
        csv: toCsv(
          [
            'id',
            'first_name',
            'last_name',
            'email',
            'phone',
            'whatsapp_phone',
            'job_title',
            'company_name',
            'lifecycle_stage',
            'status',
            'source',
            'owner',
            'tags',
            'created_at',
            'updated_at',
            ...customHeaders,
          ],
          contacts.map((c) => [
            c.id,
            c.firstName,
            c.lastName,
            c.email,
            c.phone,
            c.whatsappPhone,
            c.jobTitle,
            c.primaryCompany?.name ?? null,
            c.lifecycleStage,
            c.status,
            c.source,
            c.ownerName,
            c.tags.map((t) => t.name).join('; '),
            c.createdAt,
            c.updatedAt,
            ...customCells(fields, c.customFields),
          ]),
        ),
      };
    }
    case 'company': {
      const filters = { ...filtersFor.company.parse(rest), customFields };
      const companies = await collect<CompanySummary>((cursor) =>
        listCompanies(tx, ctx, {
          ...filters,
          limit: PAGE,
          cursor,
          sort: 'created_asc',
        }),
      );
      if (!companies) return null;
      return {
        rows: companies.length,
        csv: toCsv(
          [
            'id',
            'name',
            'domain',
            'website',
            'phone',
            'industry',
            'employee_count',
            'city',
            'country_code',
            'owner',
            'contacts',
            'tags',
            'created_at',
            'updated_at',
            ...customHeaders,
          ],
          companies.map((c) => [
            c.id,
            c.name,
            c.domain,
            c.website,
            c.phone,
            c.industry,
            c.employeeCount,
            c.city,
            c.countryCode,
            c.ownerName,
            c.contactCount,
            c.tags.map((t) => t.name).join('; '),
            c.createdAt,
            c.updatedAt,
            ...customCells(fields, c.customFields),
          ]),
        ),
      };
    }
    case 'deal': {
      const filters = { ...filtersFor.deal.parse(rest), customFields };
      const deals = await collect<DealSummary>((cursor) =>
        listDeals(tx, ctx, { ...filters, limit: PAGE, cursor, sort: 'created_asc' }),
      );
      if (!deals) return null;
      return {
        rows: deals.length,
        csv: toCsv(
          [
            'id',
            'name',
            'pipeline',
            'stage',
            'status',
            'value',
            'currency',
            'probability',
            'expected_close_date',
            'contact',
            'company',
            'owner',
            'closed_at',
            'lost_reason',
            'tags',
            'created_at',
            ...customHeaders,
          ],
          deals.map((d) => [
            d.id,
            d.name,
            d.pipelineName,
            d.stageName,
            d.status,
            d.value?.amount ?? null,
            d.currency,
            d.probability,
            d.expectedCloseDate,
            d.contact?.name ?? null,
            d.company?.name ?? null,
            d.ownerName,
            d.closedAt,
            d.lostReason,
            d.tags.map((t) => t.name).join('; '),
            d.createdAt,
            ...customCells(fields, d.customFields),
          ]),
        ),
      };
    }
  }
}

/** Worker entry point: generates the CSV for a queued export (idempotent). */
export async function processExport(
  db: Database,
  organizationId: string,
  exportId: string,
): Promise<'completed' | 'failed' | 'skipped'> {
  return withTenant(db, { organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select()
      .from(crmExports)
      .where(and(eq(crmExports.id, exportId), eq(crmExports.organizationId, organizationId)))
      .for('update');
    if (!row || (row.status !== 'queued' && row.status !== 'processing')) return 'skipped';
    const [org] = await tx
      .select({
        countryCode: organizations.countryCode,
        defaultCurrency: organizations.defaultCurrency,
        timezone: organizations.timezone,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!org) return 'skipped';
    const ctx: CrmContext = {
      organizationId,
      ...org,
      actor: { type: 'user', userId: row.createdByUserId, correlationId: `export:${row.id}` },
    };
    const result = await buildCsv(tx, ctx, row);
    if (!result) {
      await tx
        .update(crmExports)
        .set({
          status: 'failed',
          failureReason: `More than ${MAX_EXPORT_ROWS.toLocaleString('en')} rows; narrow the filters`,
          completedAt: new Date(),
        })
        .where(eq(crmExports.id, exportId));
      return 'failed';
    }
    await tx
      .update(crmExports)
      .set({
        status: 'completed',
        content: result.csv,
        contentBytes: Buffer.byteLength(result.csv, 'utf8'),
        rowCount: result.rows,
        completedAt: new Date(),
      })
      .where(eq(crmExports.id, exportId));
    return 'completed';
  });
}

/**
 * Hourly housekeeping across tenants: drops expired export files, fails exports stuck in
 * processing and purges staged rows of imports finished more than 30 days ago. Runs in system
 * scope because it is not acting for any single tenant.
 */
export async function runCrmMaintenance(
  db: Database,
): Promise<{ expiredExports: number; purgedImports: number }> {
  return withSystem(db, async (tx) => {
    const expired = await tx
      .update(crmExports)
      .set({ status: 'expired', content: null })
      .where(and(lt(crmExports.expiresAt, sql`now()`), isNotNull(crmExports.content)))
      .returning({ id: crmExports.id });
    await tx
      .update(crmExports)
      .set({ status: 'failed', failureReason: 'Export timed out', completedAt: new Date() })
      .where(
        and(
          inArray(crmExports.status, ['queued', 'processing']),
          lt(crmExports.createdAt, sql`now() - interval '2 hours'`),
        ),
      );
    const finished = await tx
      .select({ id: crmImports.id })
      .from(crmImports)
      .where(
        and(
          inArray(crmImports.status, ['completed', 'failed', 'canceled']),
          lt(crmImports.completedAt, sql`now() - interval '30 days'`),
          sql`exists (select 1 from ${crmImportRows} where ${crmImportRows.importId} = ${crmImports.id})`,
        ),
      )
      .limit(1_000);
    if (finished.length > 0) {
      await tx.delete(crmImportRows).where(
        inArray(
          crmImportRows.importId,
          finished.map((row) => row.id),
        ),
      );
    }
    return { expiredExports: expired.length, purgedImports: finished.length };
  });
}
