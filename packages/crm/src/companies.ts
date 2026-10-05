import {
  crmCompanies,
  crmCompanyTags,
  crmContactCompanies,
  crmContacts,
  isUniqueViolation,
  users,
  type CrmCompany,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import { ConflictError, NotFoundError, paginationQuerySchema, type Page } from '@businessos/shared';
import { and, asc, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { eventMeta, type CrmContext } from './context';
import { CustomFieldSet, type ApiCustomValues } from './custom-fields';
import { afterCursor, keysetPage, orderFor, sortValue, type SortSpec } from './listing';
import { assertActiveMember } from './members';
import { normalizeDomain, normalizePhone, normalizeUrl, optionalText } from './normalize';
import { MAX_BULK_IDS } from './records';
import { searchCondition } from './search';
import {
  addTags,
  removeTags,
  setRecordTags,
  tagIdsSchema,
  tagsForRecords,
  type TagSummary,
} from './tags';

const countryCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, { message: 'Two-letter ISO country code' }));

const companyFields = {
  domain: z.string().max(300).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  website: z.string().max(2000).nullable().optional(),
  industry: optionalText(100),
  employeeCount: z.number().int().min(0).max(10_000_000).nullable().optional(),
  city: optionalText(100),
  countryCode: countryCodeSchema.nullable().optional(),
  ownerUserId: z.uuid().nullable().optional(),
  customFields: z
    .record(z.string().max(60), z.unknown())
    .refine((value) => Object.keys(value).length <= 100, { message: 'Too many custom fields' })
    .optional(),
  tagIds: tagIdsSchema.optional(),
};

export const createCompanyInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  ...companyFields,
});
export const updateCompanyInputSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  ...companyFields,
});
export type CreateCompanyInput = z.input<typeof createCompanyInputSchema>;
export type UpdateCompanyInput = z.input<typeof updateCompanyInputSchema>;

export const COMPANY_SORTS = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'name_asc',
  'name_desc',
] as const;

export const companyListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  ownerUserId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
  industry: z.string().trim().max(100).optional(),
  countryCode: z.string().trim().length(2).optional(),
  tagId: z.uuid().optional(),
  sort: z.enum(COMPANY_SORTS).default('name_asc'),
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema> & {
  customFields?: Record<string, string> | undefined;
};

export interface CompanySummary {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  website: string | null;
  industry: string | null;
  employeeCount: number | null;
  city: string | null;
  countryCode: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  contactCount: number;
  tags: TagSummary[];
  customFields: ApiCustomValues;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDetail extends CompanySummary {
  createdByUserId: string | null;
}

const nameExpression = sql`lower(${crmCompanies.name})`;

function sortSpec(sort: (typeof COMPANY_SORTS)[number]): SortSpec {
  switch (sort) {
    case 'created_desc':
      return {
        name: sort,
        expression: crmCompanies.createdAt,
        direction: 'desc',
        kind: 'timestamp',
      };
    case 'created_asc':
      return {
        name: sort,
        expression: crmCompanies.createdAt,
        direction: 'asc',
        kind: 'timestamp',
      };
    case 'updated_desc':
      return {
        name: sort,
        expression: crmCompanies.updatedAt,
        direction: 'desc',
        kind: 'timestamp',
      };
    case 'name_asc':
      return { name: sort, expression: nameExpression, direction: 'asc', kind: 'text' };
    case 'name_desc':
      return { name: sort, expression: nameExpression, direction: 'desc', kind: 'text' };
  }
}

async function contactCounts(
  tx: TenantTx,
  companyIds: readonly string[],
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const rows = await tx
    .select({ companyId: crmContactCompanies.companyId, n: count() })
    .from(crmContactCompanies)
    .innerJoin(crmContacts, eq(crmContacts.id, crmContactCompanies.contactId))
    .where(
      and(inArray(crmContactCompanies.companyId, [...companyIds]), isNull(crmContacts.deletedAt)),
    )
    .groupBy(crmContactCompanies.companyId);
  return new Map(rows.map((row) => [row.companyId, row.n]));
}

function toSummary(
  company: CrmCompany,
  ownerName: string | null,
  fields: CustomFieldSet,
  tags: Map<string, TagSummary[]>,
  counts: Map<string, number>,
): CompanySummary {
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    phone: company.phone,
    website: company.website,
    industry: company.industry,
    employeeCount: company.employeeCount,
    city: company.city,
    countryCode: company.countryCode,
    ownerUserId: company.ownerUserId,
    ownerName: company.ownerUserId === null ? null : ownerName,
    contactCount: counts.get(company.id) ?? 0,
    tags: tags.get(company.id) ?? [],
    customFields: fields.toApi(company.customFields),
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

export async function companyFilterConditions(
  tx: TenantTx,
  ctx: CrmContext,
  query: Omit<CompanyListQuery, 'limit' | 'cursor' | 'sort'>,
  fields?: CustomFieldSet,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    eq(crmCompanies.organizationId, ctx.organizationId),
    isNull(crmCompanies.deletedAt),
  ];
  if (query.q) {
    const search = searchCondition(crmCompanies.searchVector, query.q, [crmCompanies.phone]);
    if (search) conditions.push(search);
  }
  if (query.ownerUserId === 'none') conditions.push(isNull(crmCompanies.ownerUserId));
  else if (query.ownerUserId === 'me') {
    conditions.push(ctx.actor.userId ? eq(crmCompanies.ownerUserId, ctx.actor.userId) : sql`false`);
  } else if (query.ownerUserId) conditions.push(eq(crmCompanies.ownerUserId, query.ownerUserId));
  if (query.industry) conditions.push(eq(crmCompanies.industry, query.industry));
  if (query.countryCode)
    conditions.push(eq(crmCompanies.countryCode, query.countryCode.toUpperCase()));
  if (query.tagId) {
    conditions.push(
      sql`exists (select 1 from ${crmCompanyTags} where ${crmCompanyTags.companyId} = ${crmCompanies.id} and ${crmCompanyTags.tagId} = ${query.tagId})`,
    );
  }
  if (query.customFields && Object.keys(query.customFields).length > 0) {
    const set = fields ?? (await CustomFieldSet.load(tx, ctx.organizationId, 'company'));
    const document = set.filterDocument(query.customFields);
    if (document)
      conditions.push(sql`${crmCompanies.customFields} @> ${JSON.stringify(document)}::jsonb`);
  }
  return conditions;
}

export async function listCompanies(
  tx: TenantTx,
  ctx: CrmContext,
  query: CompanyListQuery,
): Promise<Page<CompanySummary>> {
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'company');
  const conditions = await companyFilterConditions(tx, ctx, query, fields);
  const spec = sortSpec(query.sort);
  const after = afterCursor(spec, crmCompanies.id, query.cursor);
  if (after) conditions.push(after);
  const rows = await tx
    .select({
      company: crmCompanies,
      ownerName: users.name,
      id: crmCompanies.id,
      sortValue: sortValue(spec),
    })
    .from(crmCompanies)
    .leftJoin(users, eq(users.id, crmCompanies.ownerUserId))
    .where(and(...conditions))
    .orderBy(...orderFor(spec, crmCompanies.id))
    .limit(query.limit + 1);
  const pageIds = rows.slice(0, query.limit).map((row) => row.id);
  const [tags, counts] = [
    await tagsForRecords(tx, 'company', pageIds),
    await contactCounts(tx, pageIds),
  ];
  return keysetPage(spec, rows, query.limit, (row) =>
    toSummary(row.company, row.ownerName, fields, tags, counts),
  );
}

export async function getCompany(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<CompanyDetail> {
  const [row] = await tx
    .select({ company: crmCompanies, ownerName: users.name })
    .from(crmCompanies)
    .leftJoin(users, eq(users.id, crmCompanies.ownerUserId))
    .where(
      and(
        eq(crmCompanies.id, id),
        eq(crmCompanies.organizationId, ctx.organizationId),
        isNull(crmCompanies.deletedAt),
      ),
    );
  if (!row) throw new NotFoundError('Company');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'company');
  const tags = await tagsForRecords(tx, 'company', [id]);
  const counts = await contactCounts(tx, [id]);
  return {
    ...toSummary(row.company, row.ownerName, fields, tags, counts),
    createdByUserId: row.company.createdByUserId,
  };
}

interface NormalizedCompanyFields {
  domain?: string | null;
  phone?: string | null;
  website?: string | null;
}

function normalizeCompanyFields(
  ctx: CrmContext,
  input: {
    domain?: string | null | undefined;
    phone?: string | null | undefined;
    website?: string | null | undefined;
  },
): NormalizedCompanyFields {
  const blank = (value: string | null | undefined) => value === null || value?.trim() === '';
  const out: NormalizedCompanyFields = {};
  if (input.domain !== undefined)
    out.domain = blank(input.domain) ? null : normalizeDomain(input.domain ?? '');
  if (input.phone !== undefined)
    out.phone = blank(input.phone) ? null : normalizePhone(input.phone ?? '', ctx.countryCode);
  if (input.website !== undefined) {
    out.website = blank(input.website) ? null : normalizeUrl(input.website ?? '', 'website');
  }
  // A website without an explicit domain supplies one (dedupe key).
  if (out.domain === undefined && out.website) {
    try {
      out.domain = normalizeDomain(out.website);
    } catch {
      // Websites such as IP addresses have no usable domain.
    }
  }
  return out;
}

function translateCompanyConflict(error: unknown): never {
  if (isUniqueViolation(error, 'crm_companies_org_domain_unique')) {
    throw new ConflictError('A company with this domain already exists', {
      details: [{ path: 'domain', message: 'Already used by another company' }],
    });
  }
  throw error;
}

export async function createCompany(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: CreateCompanyInput,
): Promise<CompanyDetail> {
  const input = createCompanyInputSchema.parse(rawInput);
  const normalized = normalizeCompanyFields(ctx, input);
  const ownerUserId = input.ownerUserId === undefined ? ctx.actor.userId : input.ownerUserId;
  if (ownerUserId !== null)
    await assertActiveMember(tx, ctx.organizationId, ownerUserId, 'ownerUserId');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'company');
  const customFields = await fields.apply(tx, ctx, input.customFields, null);
  let company: CrmCompany | undefined;
  try {
    [company] = await tx
      .insert(crmCompanies)
      .values({
        organizationId: ctx.organizationId,
        name: input.name,
        domain: normalized.domain ?? null,
        phone: normalized.phone ?? null,
        website: normalized.website ?? null,
        industry: input.industry ?? null,
        employeeCount: input.employeeCount ?? null,
        city: input.city ?? null,
        countryCode: input.countryCode ?? null,
        ownerUserId,
        customFields,
        createdByUserId: ctx.actor.userId,
      })
      .returning();
  } catch (error) {
    translateCompanyConflict(error);
  }
  if (!company) throw new Error('company insert returned no row');
  if (input.tagIds?.length)
    await addTags(tx, ctx.organizationId, 'company', [company.id], input.tagIds);
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'company.created',
    subject: { type: 'company', id: company.id },
    payload: { companyId: company.id },
  });
  return getCompany(tx, ctx, company.id);
}

async function lockCompany(tx: TenantTx, organizationId: string, id: string): Promise<CrmCompany> {
  const [company] = await tx
    .select()
    .from(crmCompanies)
    .where(
      and(
        eq(crmCompanies.id, id),
        eq(crmCompanies.organizationId, organizationId),
        isNull(crmCompanies.deletedAt),
      ),
    )
    .for('update');
  if (!company) throw new NotFoundError('Company');
  return company;
}

export async function updateCompany(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: UpdateCompanyInput,
): Promise<{ before: CompanyDetail; after: CompanyDetail; changedFields: string[] }> {
  const input = updateCompanyInputSchema.parse(rawInput);
  const current = await lockCompany(tx, ctx.organizationId, id);
  const before = await getCompany(tx, ctx, id);
  const normalized = normalizeCompanyFields(ctx, input);
  const set: Partial<typeof crmCompanies.$inferInsert> = {};
  const changed: string[] = [];
  const assign = <K extends keyof CrmCompany & keyof typeof crmCompanies.$inferInsert>(
    key: K,
    value: CrmCompany[K] | undefined,
  ) => {
    if (value === undefined) return;
    const same =
      typeof value === 'object' && value !== null
        ? JSON.stringify(value) === JSON.stringify(current[key])
        : value === current[key];
    if (!same) {
      (set as Record<string, unknown>)[key] = value;
      changed.push(key);
    }
  };
  assign('name', input.name);
  assign('domain', normalized.domain);
  assign('phone', normalized.phone);
  assign('website', normalized.website);
  assign('industry', input.industry);
  assign('employeeCount', input.employeeCount);
  assign('city', input.city);
  assign('countryCode', input.countryCode);
  if (input.ownerUserId !== undefined && input.ownerUserId !== current.ownerUserId) {
    if (input.ownerUserId !== null)
      await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
    assign('ownerUserId', input.ownerUserId);
  }
  if (input.customFields !== undefined) {
    const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'company');
    assign('customFields', await fields.apply(tx, ctx, input.customFields, current.customFields));
  }
  if (input.tagIds) {
    const tagChanges = await setRecordTags(tx, ctx.organizationId, 'company', id, input.tagIds);
    if (tagChanges.added.length > 0 || tagChanges.removed.length > 0) changed.push('tags');
  }
  if (changed.length === 0) return { before, after: before, changedFields: [] };
  try {
    await tx
      .update(crmCompanies)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(crmCompanies.id, id), eq(crmCompanies.organizationId, ctx.organizationId)));
  } catch (error) {
    translateCompanyConflict(error);
  }
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'company.updated',
    subject: { type: 'company', id },
    payload: { companyId: id, changedFields: changed },
  });
  return { before, after: await getCompany(tx, ctx, id), changedFields: changed };
}

export async function deleteCompany(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<CompanyDetail> {
  await lockCompany(tx, ctx.organizationId, id);
  const before = await getCompany(tx, ctx, id);
  await tx
    .update(crmCompanies)
    .set({ deletedAt: new Date() })
    .where(and(eq(crmCompanies.id, id), eq(crmCompanies.organizationId, ctx.organizationId)));
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'company.deleted',
    subject: { type: 'company', id },
    payload: { companyId: id },
  });
  return before;
}

export const companyBulkInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delete'), ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS) }),
  z.object({
    action: z.literal('assign_owner'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    ownerUserId: z.uuid().nullable(),
  }),
  z.object({
    action: z.literal('add_tags'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    tagIds: tagIdsSchema.pipe(z.array(z.uuid()).min(1)),
  }),
  z.object({
    action: z.literal('remove_tags'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    tagIds: tagIdsSchema.pipe(z.array(z.uuid()).min(1)),
  }),
]);
export type CompanyBulkInput = z.infer<typeof companyBulkInputSchema>;

export async function bulkUpdateCompanies(
  tx: TenantTx,
  ctx: CrmContext,
  input: CompanyBulkInput,
): Promise<{ affected: number; ids: string[] }> {
  const targets = await tx
    .select({ id: crmCompanies.id })
    .from(crmCompanies)
    .where(
      and(
        eq(crmCompanies.organizationId, ctx.organizationId),
        isNull(crmCompanies.deletedAt),
        inArray(crmCompanies.id, [...new Set(input.ids)]),
      ),
    )
    .orderBy(asc(crmCompanies.id))
    .for('update');
  const ids = targets.map((row) => row.id);
  if (ids.length === 0) return { affected: 0, ids };
  const meta = eventMeta(ctx);
  const scope = and(
    eq(crmCompanies.organizationId, ctx.organizationId),
    inArray(crmCompanies.id, ids),
  );
  switch (input.action) {
    case 'delete':
      await tx.update(crmCompanies).set({ deletedAt: new Date() }).where(scope);
      for (const id of ids) {
        await emitEvent(tx, {
          ...meta,
          type: 'company.deleted',
          subject: { type: 'company', id },
          payload: { companyId: id },
        });
      }
      break;
    case 'assign_owner':
      if (input.ownerUserId !== null) {
        await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
      }
      await tx.update(crmCompanies).set({ ownerUserId: input.ownerUserId }).where(scope);
      for (const id of ids) {
        await emitEvent(tx, {
          ...meta,
          type: 'company.updated',
          subject: { type: 'company', id },
          payload: { companyId: id, changedFields: ['ownerUserId'] },
        });
      }
      break;
    case 'add_tags':
      await addTags(tx, ctx.organizationId, 'company', ids, input.tagIds);
      break;
    case 'remove_tags':
      await removeTags(tx, ctx.organizationId, 'company', ids, input.tagIds);
      break;
  }
  return { affected: ids.length, ids };
}

/** Duplicate lookup for imports: by domain, otherwise by exact (case-insensitive) name. */
export async function findCompany(
  tx: TenantTx,
  organizationId: string,
  match: { domain?: string | null; name?: string | null },
): Promise<string | null> {
  const base = [eq(crmCompanies.organizationId, organizationId), isNull(crmCompanies.deletedAt)];
  if (match.domain) {
    const [row] = await tx
      .select({ id: crmCompanies.id })
      .from(crmCompanies)
      .where(and(...base, eq(crmCompanies.domain, match.domain)));
    if (row) return row.id;
  }
  if (match.name) {
    const [row] = await tx
      .select({ id: crmCompanies.id })
      .from(crmCompanies)
      .where(and(...base, sql`lower(${crmCompanies.name}) = lower(${match.name})`))
      .orderBy(asc(crmCompanies.createdAt))
      .limit(1);
    if (row) return row.id;
  }
  return null;
}
