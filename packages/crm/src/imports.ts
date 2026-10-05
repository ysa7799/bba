import { recordAudit } from '@businessos/audit';
import { getLimit } from '@businessos/billing';
import {
  crmContacts,
  crmImportRows,
  crmImports,
  DUPLICATE_POLICIES,
  IMPORT_ENTITIES,
  memberships,
  organizations,
  users,
  withTenant,
  type CrmImport,
  type Database,
  type ImportEntity,
  type ImportRowStatus,
  type TenantTx,
} from '@businessos/database';
import {
  AppError,
  ConflictError,
  EntitlementExceededError,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { updateCompany, createCompany, findCompany, type CreateCompanyInput } from './companies';
import type { CrmContext } from './context';
import {
  createContact,
  findContactByEmail,
  setPrimaryCompany,
  updateContact,
  type CreateContactInput,
} from './contacts';
import { parseCsv, unescapeFormula } from './csv';
import { CustomFieldSet } from './custom-fields';
import { normalizeDomain, normalizeEmail, normalizePhone } from './normalize';
import { addTags, findOrCreateTags } from './tags';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
const BATCH_SIZE = 100;
const SAMPLE_ROWS = 5;
const PREVIEW_ROWS = 20;

interface FieldDefinition {
  key: string;
  label: string;
  aliases: readonly string[];
}

const CONTACT_FIELDS: readonly FieldDefinition[] = [
  {
    key: 'first_name',
    label: 'First name',
    aliases: ['first name', 'firstname', 'given name', 'first'],
  },
  {
    key: 'last_name',
    label: 'Last name',
    aliases: ['last name', 'lastname', 'surname', 'family name', 'last'],
  },
  {
    key: 'full_name',
    label: 'Full name',
    aliases: ['name', 'full name', 'contact name', 'contact'],
  },
  { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'mail'] },
  {
    key: 'phone',
    label: 'Phone',
    aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'tel'],
  },
  {
    key: 'whatsapp_phone',
    label: 'WhatsApp number',
    aliases: ['whatsapp', 'whatsapp number', 'whatsapp phone'],
  },
  { key: 'job_title', label: 'Job title', aliases: ['job title', 'title', 'position', 'role'] },
  {
    key: 'company_name',
    label: 'Company',
    aliases: ['company', 'company name', 'organization', 'organisation', 'account'],
  },
  {
    key: 'lifecycle_stage',
    label: 'Lifecycle stage',
    aliases: ['lifecycle', 'lifecycle stage', 'stage'],
  },
  { key: 'status', label: 'Status', aliases: ['status'] },
  { key: 'source', label: 'Source', aliases: ['source', 'lead source'] },
  {
    key: 'owner_email',
    label: 'Owner (member email)',
    aliases: ['owner', 'owner email', 'assigned to'],
  },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'labels'] },
];

const COMPANY_FIELDS: readonly FieldDefinition[] = [
  {
    key: 'name',
    label: 'Name',
    aliases: ['name', 'company', 'company name', 'organization', 'organisation'],
  },
  { key: 'domain', label: 'Domain', aliases: ['domain', 'company domain'] },
  { key: 'website', label: 'Website', aliases: ['website', 'web', 'url', 'site'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'phone number', 'telephone', 'tel'] },
  { key: 'industry', label: 'Industry', aliases: ['industry', 'sector'] },
  {
    key: 'employee_count',
    label: 'Employees',
    aliases: ['employees', 'employee count', 'size', 'headcount'],
  },
  { key: 'city', label: 'City', aliases: ['city', 'town'] },
  { key: 'country_code', label: 'Country code', aliases: ['country', 'country code'] },
  {
    key: 'owner_email',
    label: 'Owner (member email)',
    aliases: ['owner', 'owner email', 'assigned to'],
  },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'labels'] },
];

export const createImportInputSchema = z.object({
  entityType: z.enum(IMPORT_ENTITIES),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .transform((name) => name.replace(/[^\p{L}\p{N} ._()-]/gu, '_')),
  content: z.string().min(1).max(MAX_IMPORT_BYTES),
});

export const updateImportInputSchema = z.object({
  /** Column index → target field key (omit or "" to skip a column). */
  mapping: z.record(z.string().regex(/^\d{1,2}$/), z.string().max(80)),
  duplicatePolicy: z.enum(DUPLICATE_POLICIES).default('skip'),
});

export interface ImportField {
  key: string;
  label: string;
}

export interface ImportDetail {
  id: string;
  entityType: ImportEntity;
  status: CrmImport['status'];
  fileName: string;
  headers: string[];
  mapping: Record<string, string>;
  duplicatePolicy: CrmImport['duplicatePolicy'];
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  failureReason: string | null;
  createdByUserId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ImportRowResult {
  rowNumber: number;
  status: ImportRowStatus;
  error: string | null;
  recordId: string | null;
}

function toDetail(row: CrmImport): ImportDetail {
  return {
    id: row.id,
    entityType: row.entityType,
    status: row.status,
    fileName: row.fileName,
    headers: row.headers,
    mapping: row.mapping,
    duplicatePolicy: row.duplicatePolicy,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    failureReason: row.failureReason,
    createdByUserId: row.createdByUserId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Targets a column can map to: built-in fields plus active custom fields (`cf:<key>`). */
export async function importFields(
  tx: TenantTx,
  organizationId: string,
  entityType: ImportEntity,
): Promise<ImportField[]> {
  const builtIn = entityType === 'contact' ? CONTACT_FIELDS : COMPANY_FIELDS;
  const custom = await CustomFieldSet.load(tx, organizationId, entityType);
  return [
    ...builtIn.map(({ key, label }) => ({ key, label })),
    ...custom.active().map((field) => ({ key: `cf:${field.key}`, label: field.label })),
  ];
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
}

/** Suggests a mapping from header names (aliases, field keys, custom field labels). */
export function suggestMapping(
  headers: readonly string[],
  entityType: ImportEntity,
  customFields: readonly ImportField[],
): Record<string, string> {
  const builtIn = entityType === 'contact' ? CONTACT_FIELDS : COMPANY_FIELDS;
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const match =
      builtIn.find(
        (field) => field.aliases.includes(normalized) || normalizeHeader(field.key) === normalized,
      )?.key ??
      customFields.find(
        (field) =>
          normalizeHeader(field.label) === normalized ||
          normalizeHeader(field.key) === normalized ||
          field.key === `cf:${normalized.replace(/ /g, '_')}`,
      )?.key;
    if (match && !used.has(match)) {
      mapping[String(index)] = match;
      used.add(match);
    }
  });
  // "Name" alone is a full name only when first/last are not mapped separately.
  if (used.has('full_name') && (used.has('first_name') || used.has('last_name'))) {
    return Object.fromEntries(
      Object.entries(mapping).filter(([, target]) => target !== 'full_name'),
    );
  }
  return mapping;
}

async function getImportRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
  lock = false,
): Promise<CrmImport> {
  const query = tx
    .select()
    .from(crmImports)
    .where(and(eq(crmImports.id, id), eq(crmImports.organizationId, organizationId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Import');
  return row;
}

export async function getImport(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<
  ImportDetail & { fields: ImportField[]; sampleRows: string[][]; errors: ImportRowResult[] }
> {
  const row = await getImportRow(tx, organizationId, id);
  const sample = await tx
    .select({ values: crmImportRows.values })
    .from(crmImportRows)
    .where(eq(crmImportRows.importId, id))
    .orderBy(asc(crmImportRows.rowNumber))
    .limit(SAMPLE_ROWS);
  const errors = await tx
    .select({
      rowNumber: crmImportRows.rowNumber,
      status: crmImportRows.status,
      error: crmImportRows.error,
      recordId: crmImportRows.recordId,
    })
    .from(crmImportRows)
    .where(and(eq(crmImportRows.importId, id), eq(crmImportRows.status, 'failed')))
    .orderBy(asc(crmImportRows.rowNumber))
    .limit(200);
  return {
    ...toDetail(row),
    fields: await importFields(tx, organizationId, row.entityType),
    sampleRows: sample.map((entry) => entry.values),
    errors,
  };
}

export async function listImports(tx: TenantTx, organizationId: string): Promise<ImportDetail[]> {
  const rows = await tx
    .select()
    .from(crmImports)
    .where(eq(crmImports.organizationId, organizationId))
    .orderBy(desc(crmImports.createdAt))
    .limit(25);
  return rows.map(toDetail);
}

/** Parses and stages an uploaded CSV. Nothing is written to CRM records until it is started. */
export async function createImport(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: z.input<typeof createImportInputSchema>,
): Promise<ImportDetail> {
  const input = createImportInputSchema.parse(rawInput);
  const rows = parseCsv(input.content, {
    maxRows: MAX_IMPORT_ROWS + 1,
    maxColumns: 60,
    maxFieldLength: 10_000,
  });
  const [headerRow, ...dataRows] = rows;
  if (!headerRow || dataRows.length === 0) {
    throw new ValidationError('The file has no data rows', [
      { path: 'file', message: 'Expected a header row followed by at least one row' },
    ]);
  }
  const headers = headerRow.map(
    (header, index) => header.trim().slice(0, 100) || `Column ${index + 1}`,
  );
  const fields = await importFields(tx, ctx.organizationId, input.entityType);
  const mapping = suggestMapping(
    headers,
    input.entityType,
    fields.filter((field) => field.key.startsWith('cf:')),
  );
  const [created] = await tx
    .insert(crmImports)
    .values({
      organizationId: ctx.organizationId,
      entityType: input.entityType,
      fileName: input.fileName,
      headers,
      mapping,
      totalRows: dataRows.length,
      createdByUserId: ctx.actor.userId,
    })
    .returning();
  if (!created) throw new Error('import insert returned no row');
  for (let start = 0; start < dataRows.length; start += 500) {
    await tx.insert(crmImportRows).values(
      dataRows.slice(start, start + 500).map((values, offset) => ({
        organizationId: ctx.organizationId,
        importId: created.id,
        rowNumber: start + offset + 1,
        values: headers.map((_, index) => values[index] ?? ''),
      })),
    );
  }
  return toDetail(created);
}

function validateMapping(
  entityType: ImportEntity,
  headers: readonly string[],
  mapping: Record<string, string>,
  fields: readonly ImportField[],
): Record<string, string> {
  const allowed = new Set(fields.map((field) => field.key));
  const clean: Record<string, string> = {};
  const used = new Set<string>();
  for (const [column, target] of Object.entries(mapping)) {
    if (target === '') continue;
    if (Number(column) >= headers.length) {
      throw new ValidationError('Invalid mapping', [
        { path: `mapping.${column}`, message: 'No such column' },
      ]);
    }
    if (!allowed.has(target)) {
      throw new ValidationError('Invalid mapping', [
        { path: `mapping.${column}`, message: 'Unknown field' },
      ]);
    }
    if (used.has(target)) {
      throw new ValidationError('Invalid mapping', [
        { path: `mapping.${column}`, message: 'Each field can be mapped from one column only' },
      ]);
    }
    used.add(target);
    clean[column] = target;
  }
  const identity =
    entityType === 'contact'
      ? ['first_name', 'last_name', 'full_name', 'email', 'phone', 'whatsapp_phone']
      : ['name'];
  if (!identity.some((key) => used.has(key))) {
    throw new ValidationError('Invalid mapping', [
      {
        path: 'mapping',
        message:
          entityType === 'contact'
            ? 'Map at least one of: name, email or phone'
            : 'Map the company name',
      },
    ]);
  }
  return clean;
}

export async function updateImportMapping(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateImportInputSchema>,
): Promise<ImportDetail> {
  const input = updateImportInputSchema.parse(rawInput);
  const row = await getImportRow(tx, ctx.organizationId, id, true);
  if (row.status !== 'uploaded') throw new ConflictError('This import has already started');
  const fields = await importFields(tx, ctx.organizationId, row.entityType);
  const mapping = validateMapping(row.entityType, row.headers, input.mapping, fields);
  const [updated] = await tx
    .update(crmImports)
    .set({ mapping, duplicatePolicy: input.duplicatePolicy })
    .where(and(eq(crmImports.id, id), eq(crmImports.organizationId, ctx.organizationId)))
    .returning();
  if (!updated) throw new NotFoundError('Import');
  return toDetail(updated);
}

/** Queues a staged import for the worker. Idempotent while queued (safe to retry enqueueing). */
export async function startImport(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<ImportDetail> {
  const row = await getImportRow(tx, ctx.organizationId, id, true);
  if (row.status === 'queued') return toDetail(row);
  if (row.status !== 'uploaded') throw new ConflictError('This import has already started');
  const fields = await importFields(tx, ctx.organizationId, row.entityType);
  validateMapping(row.entityType, row.headers, row.mapping, fields);
  const [updated] = await tx
    .update(crmImports)
    .set({ status: 'queued' })
    .where(and(eq(crmImports.id, id), eq(crmImports.organizationId, ctx.organizationId)))
    .returning();
  if (!updated) throw new NotFoundError('Import');
  return toDetail(updated);
}

export async function cancelImport(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<ImportDetail> {
  const row = await getImportRow(tx, ctx.organizationId, id, true);
  if (!['uploaded', 'queued', 'processing'].includes(row.status)) {
    throw new ConflictError('This import has already finished');
  }
  const [updated] = await tx
    .update(crmImports)
    .set({ status: 'canceled', completedAt: new Date() })
    .where(and(eq(crmImports.id, id), eq(crmImports.organizationId, ctx.organizationId)))
    .returning();
  if (!updated) throw new NotFoundError('Import');
  return toDetail(updated);
}

/** Values of one CSV row keyed by target field. Empty cells are dropped. */
function mappedValues(
  values: readonly string[],
  mapping: Record<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [column, target] of Object.entries(mapping)) {
    const value = unescapeFormula((values[Number(column)] ?? '').trim());
    if (value !== '') out.set(target, value);
  }
  return out;
}

function splitList(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Converts CSV text for a custom field into the JSON value its type expects. */
function customValue(fields: CustomFieldSet, key: string, raw: string): unknown {
  const field = fields.byKey.get(key);
  if (!field) return raw;
  switch (field.type) {
    case 'boolean': {
      const lowered = raw.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(lowered)) return true;
      if (['false', 'no', 'n', '0'].includes(lowered)) return false;
      return raw;
    }
    case 'multi_select':
      return splitList(raw);
    case 'select': {
      const option = field.options.find(
        (candidate) =>
          candidate.value === raw || candidate.label.toLowerCase() === raw.toLowerCase(),
      );
      return option?.value ?? raw;
    }
    default:
      return raw;
  }
}

interface RowContext {
  ctx: CrmContext;
  fields: CustomFieldSet;
  /** Member emails → user ids. */
  members: Map<string, string>;
}

function customFieldsFrom(
  values: Map<string, string>,
  rowCtx: RowContext,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [target, raw] of values) {
    if (target.startsWith('cf:')) {
      const key = target.slice(3);
      out[key] = customValue(rowCtx.fields, key, raw);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function ownerFrom(values: Map<string, string>, rowCtx: RowContext): string | undefined {
  const email = values.get('owner_email');
  if (email === undefined) return undefined;
  const userId = rowCtx.members.get(email.toLowerCase());
  if (!userId) {
    throw new ValidationError('Unknown owner', [
      { path: 'owner_email', message: 'Not an active member' },
    ]);
  }
  return userId;
}

function enumValue<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  path: string,
): T | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError('Invalid value', [
      { path, message: `One of: ${allowed.join(', ')}` },
    ]);
  }
  return value as T;
}

function contactInput(
  values: Map<string, string>,
  rowCtx: RowContext,
  createMissing: boolean,
): { input: CreateContactInput; tags: string[]; companyName: string | undefined } {
  let firstName = values.get('first_name');
  let lastName = values.get('last_name');
  const fullName = values.get('full_name');
  if (fullName !== undefined && firstName === undefined && lastName === undefined) {
    const [first, ...rest] = fullName.split(/\s+/);
    firstName = first;
    lastName = rest.length > 0 ? rest.join(' ') : undefined;
  }
  const input: CreateContactInput = {
    firstName,
    lastName,
    email: values.get('email'),
    phone: values.get('phone'),
    whatsappPhone: values.get('whatsapp_phone'),
    jobTitle: values.get('job_title'),
    lifecycleStage: enumValue(
      values.get('lifecycle_stage'),
      [
        'subscriber',
        'lead',
        'qualified',
        'opportunity',
        'customer',
        'evangelist',
        'other',
      ] as const,
      'lifecycle_stage',
    ),
    status: enumValue(values.get('status'), ['active', 'inactive'] as const, 'status'),
    source: values.get('source')?.slice(0, 50),
    customFields: customFieldsFrom(values, rowCtx),
  };
  const owner = ownerFrom(values, rowCtx);
  if (owner !== undefined) input.ownerUserId = owner;
  const tags = values.has('tags') && createMissing ? splitList(values.get('tags') ?? '') : [];
  return { input, tags, companyName: values.get('company_name') };
}

function describeError(error: unknown): string {
  if (error instanceof EntitlementExceededError) return 'Contact limit reached for your plan';
  if (error instanceof ValidationError) {
    const details = error.details ?? [];
    return details.length > 0
      ? details
          .map((detail) => `${detail.path}: ${detail.message}`)
          .join('; ')
          .slice(0, 500)
      : error.message;
  }
  if (error instanceof AppError) return error.message.slice(0, 500);
  return 'Could not import this row';
}

async function importContactRow(
  tx: TenantTx,
  values: Map<string, string>,
  rowCtx: RowContext,
  policy: CrmImport['duplicatePolicy'],
  capacity: { remaining: number | null },
): Promise<{ status: ImportRowStatus; recordId: string | null }> {
  const { ctx } = rowCtx;
  const { input, tags, companyName } = contactInput(values, rowCtx, true);
  const email = input.email ? normalizeEmail(input.email) : null;
  const existing = email ? await findContactByEmail(tx, ctx.organizationId, email) : null;
  const companyId = companyName
    ? ((await findCompany(tx, ctx.organizationId, { name: companyName })) ??
      (await createCompany(tx, ctx, { name: companyName.slice(0, 200) })).id)
    : null;
  const tagIds = tags.length > 0 ? await findOrCreateTags(tx, ctx.organizationId, tags) : [];
  if (existing) {
    if (policy === 'skip') return { status: 'skipped', recordId: existing };
    const { email: _email, ...patch } = input;
    await updateContact(tx, ctx, existing, patch);
    if (companyId) await setPrimaryCompany(tx, ctx.organizationId, existing, companyId);
    if (tagIds.length > 0) await addTags(tx, ctx.organizationId, 'contact', [existing], tagIds);
    return { status: 'updated', recordId: existing };
  }
  if (capacity.remaining !== null) {
    if (capacity.remaining <= 0) {
      throw new EntitlementExceededError('crm.contacts.max', 'Contact limit reached for your plan');
    }
  }
  const created = await createContact(
    tx,
    ctx,
    { ...input, source: input.source ?? 'import', companyId, tagIds },
    { capacityChecked: true },
  );
  if (capacity.remaining !== null) capacity.remaining -= 1;
  return { status: 'created', recordId: created.id };
}

async function importCompanyRow(
  tx: TenantTx,
  values: Map<string, string>,
  rowCtx: RowContext,
  policy: CrmImport['duplicatePolicy'],
): Promise<{ status: ImportRowStatus; recordId: string | null }> {
  const { ctx } = rowCtx;
  const name = values.get('name');
  if (!name) throw new ValidationError('Missing name', [{ path: 'name', message: 'Required' }]);
  const employees = values.get('employee_count');
  if (employees !== undefined && !/^\d{1,8}$/.test(employees.replace(/[,\s]/g, ''))) {
    throw new ValidationError('Invalid value', [
      { path: 'employee_count', message: 'Must be a whole number' },
    ]);
  }
  const website = values.get('website');
  const domainRaw = values.get('domain') ?? website;
  let domain: string | null = null;
  if (domainRaw) {
    try {
      domain = normalizeDomain(domainRaw);
    } catch (error) {
      if (values.has('domain')) throw error;
    }
  }
  const input: CreateCompanyInput = {
    name: name.slice(0, 200),
    domain: values.get('domain'),
    website,
    phone: values.get('phone'),
    industry: values.get('industry'),
    employeeCount: employees === undefined ? undefined : Number(employees.replace(/[,\s]/g, '')),
    city: values.get('city'),
    countryCode: values.get('country_code'),
    customFields: customFieldsFrom(values, rowCtx),
  };
  const owner = ownerFrom(values, rowCtx);
  if (owner !== undefined) input.ownerUserId = owner;
  const tags = values.has('tags') ? splitList(values.get('tags') ?? '') : [];
  const tagIds = tags.length > 0 ? await findOrCreateTags(tx, ctx.organizationId, tags) : [];
  const existing = await findCompany(tx, ctx.organizationId, { domain, name });
  if (existing) {
    if (policy === 'skip') return { status: 'skipped', recordId: existing };
    const { name: _name, ...patch } = input;
    await updateCompany(tx, ctx, existing, patch);
    if (tagIds.length > 0) await addTags(tx, ctx.organizationId, 'company', [existing], tagIds);
    return { status: 'updated', recordId: existing };
  }
  const created = await createCompany(tx, ctx, { ...input, tagIds });
  return { status: 'created', recordId: created.id };
}

async function memberEmails(tx: TenantTx, organizationId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ email: users.email, userId: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, 'active')));
  return new Map(rows.map((row) => [row.email.toLowerCase(), row.userId]));
}

async function contextFor(tx: TenantTx, row: CrmImport): Promise<CrmContext> {
  const [org] = await tx
    .select({
      countryCode: organizations.countryCode,
      defaultCurrency: organizations.defaultCurrency,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId));
  if (!org) throw new NotFoundError('Organization');
  return {
    organizationId: row.organizationId,
    ...org,
    actor: { type: 'user', userId: row.createdByUserId, correlationId: `import:${row.id}` },
  };
}

/** Dry run over the first rows with the current mapping: what would happen, without writing. */
export async function previewImport(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<{ rowNumber: number; values: Record<string, string>; error: string | null }[]> {
  const row = await getImportRow(tx, ctx.organizationId, id);
  const rows = await tx
    .select()
    .from(crmImportRows)
    .where(eq(crmImportRows.importId, id))
    .orderBy(asc(crmImportRows.rowNumber))
    .limit(PREVIEW_ROWS);
  const rowCtx: RowContext = {
    ctx,
    fields: await CustomFieldSet.load(tx, ctx.organizationId, row.entityType),
    members: await memberEmails(tx, ctx.organizationId),
  };
  const results = [];
  for (const staged of rows) {
    const values = mappedValues(staged.values, row.mapping);
    let error: string | null = null;
    try {
      if (values.size === 0)
        throw new ValidationError('Empty row', [{ path: 'row', message: 'No mapped values' }]);
      if (row.entityType === 'contact') {
        const { input } = contactInput(values, rowCtx, false);
        if (input.email) normalizeEmail(input.email);
        if (input.phone) normalizePhone(input.phone, ctx.countryCode);
        if (input.whatsappPhone)
          normalizePhone(input.whatsappPhone, ctx.countryCode, 'whatsapp_phone');
        if (
          !input.firstName &&
          !input.lastName &&
          !input.email &&
          !input.phone &&
          !input.whatsappPhone
        ) {
          throw new ValidationError('Missing identity', [
            { path: 'row', message: 'Needs a name, email or phone' },
          ]);
        }
        await rowCtx.fields.apply(tx, ctx, input.customFields, null);
      } else {
        if (!values.get('name'))
          throw new ValidationError('Missing name', [{ path: 'name', message: 'Required' }]);
        const phone = values.get('phone');
        if (phone) normalizePhone(phone, ctx.countryCode);
        const domain = values.get('domain');
        if (domain) normalizeDomain(domain);
        await rowCtx.fields.apply(tx, ctx, customFieldsFrom(values, rowCtx), null);
        ownerFrom(values, rowCtx);
      }
    } catch (caught) {
      error = describeError(caught);
    }
    results.push({ rowNumber: staged.rowNumber, values: Object.fromEntries(values), error });
  }
  return results;
}

export type ProcessImportResult = 'completed' | 'canceled' | 'skipped';

/**
 * Worker entry point. Processes pending rows in batches, each batch in its own transaction (so
 * progress is visible and a crash resumes where it stopped); each row runs in a savepoint so a
 * bad row fails alone. Idempotent: finished rows are never processed twice.
 */
export async function processImport(
  db: Database,
  organizationId: string,
  importId: string,
  options: { batchSize?: number } = {},
): Promise<ProcessImportResult> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  for (;;) {
    const outcome = await withTenant(db, { organizationId, userId: null }, async (tx) => {
      const row = await getImportRow(tx, organizationId, importId, true).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      });
      if (!row) return 'skipped' as const;
      if (row.status === 'canceled') return 'canceled' as const;
      if (row.status !== 'queued' && row.status !== 'processing') return 'skipped' as const;
      if (row.status === 'queued') {
        await tx
          .update(crmImports)
          .set({ status: 'processing', startedAt: new Date() })
          .where(eq(crmImports.id, importId));
      }
      const pending = await tx
        .select()
        .from(crmImportRows)
        .where(and(eq(crmImportRows.importId, importId), eq(crmImportRows.status, 'pending')))
        .orderBy(asc(crmImportRows.rowNumber))
        .limit(batchSize);
      const ctx = await contextFor(tx, row);
      if (pending.length === 0) {
        const [done] = await tx
          .update(crmImports)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(crmImports.id, importId))
          .returning();
        await recordAudit(
          tx,
          {
            actorType: 'system',
            actorUserId: row.createdByUserId,
            actorLabel: 'crm.import',
            ipAddress: null,
            userAgent: null,
            requestId: null,
          },
          {
            organizationId,
            action: 'crm.import.completed',
            target: { type: 'crm_import', id: importId },
            metadata: {
              entityType: row.entityType,
              created: done?.createdCount ?? 0,
              updated: done?.updatedCount ?? 0,
              skipped: done?.skippedCount ?? 0,
              failed: done?.failedCount ?? 0,
            },
          },
        );
        return 'completed' as const;
      }
      const rowCtx: RowContext = {
        ctx,
        fields: await CustomFieldSet.load(tx, organizationId, row.entityType),
        members: await memberEmails(tx, organizationId),
      };
      const capacity = { remaining: null as number | null };
      if (row.entityType === 'contact') {
        const limit = await getLimit(tx, organizationId, 'crm.contacts.max');
        if (limit !== null) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`crm.contacts:${organizationId}`}, 0))`,
          );
          const [used] = await tx
            .select({ n: count() })
            .from(crmContacts)
            .where(
              and(eq(crmContacts.organizationId, organizationId), isNull(crmContacts.deletedAt)),
            );
          capacity.remaining = limit - (used?.n ?? 0);
        }
      }
      const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
      for (const staged of pending) {
        const values = mappedValues(staged.values, row.mapping);
        let result: { status: ImportRowStatus; recordId: string | null; error: string | null };
        if (values.size === 0) {
          result = { status: 'skipped', recordId: null, error: 'Empty row' };
        } else {
          try {
            result = {
              ...(await tx.transaction((sp) =>
                row.entityType === 'contact'
                  ? importContactRow(sp as TenantTx, values, rowCtx, row.duplicatePolicy, capacity)
                  : importCompanyRow(sp as TenantTx, values, rowCtx, row.duplicatePolicy),
              )),
              error: null,
            };
          } catch (error) {
            result = { status: 'failed', recordId: null, error: describeError(error) };
          }
        }
        if (result.status === 'created') counts.created += 1;
        else if (result.status === 'updated') counts.updated += 1;
        else if (result.status === 'skipped') counts.skipped += 1;
        else counts.failed += 1;
        await tx
          .update(crmImportRows)
          .set({ status: result.status, recordId: result.recordId, error: result.error })
          .where(
            and(
              eq(crmImportRows.importId, importId),
              eq(crmImportRows.rowNumber, staged.rowNumber),
            ),
          );
      }
      await tx
        .update(crmImports)
        .set({
          processedRows: sql`${crmImports.processedRows} + ${pending.length}`,
          createdCount: sql`${crmImports.createdCount} + ${counts.created}`,
          updatedCount: sql`${crmImports.updatedCount} + ${counts.updated}`,
          skippedCount: sql`${crmImports.skippedCount} + ${counts.skipped}`,
          failedCount: sql`${crmImports.failedCount} + ${counts.failed}`,
        })
        .where(eq(crmImports.id, importId));
      return 'continue' as const;
    });
    if (outcome !== 'continue') return outcome;
  }
}
