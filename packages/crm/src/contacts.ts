import {
  CONTACT_STATUSES,
  crmCompanies,
  crmContactCompanies,
  crmContacts,
  crmContactTags,
  isUniqueViolation,
  LIFECYCLE_STAGES,
  users,
  type CrmContact,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  ConflictError,
  NotFoundError,
  paginationQuerySchema,
  ValidationError,
  type Page,
} from '@businessos/shared';
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { canRead, eventMeta, type CrmContext } from './context';
import { CustomFieldSet, type ApiCustomValues } from './custom-fields';
import { assertContactCapacity } from './limits';
import { afterCursor, keysetPage, orderFor, sortValue, type SortSpec } from './listing';
import { assertActiveMember } from './members';
import { displayName, normalizeEmail, normalizePhone, optionalText } from './normalize';
import { assertCompanyExists, MAX_BULK_IDS } from './records';
import { searchCondition } from './search';
import {
  addTags,
  removeTags,
  setRecordTags,
  tagIdsSchema,
  tagsForRecords,
  type TagSummary,
} from './tags';

const customFieldsInput = z
  .record(z.string().max(60), z.unknown())
  .refine((value) => Object.keys(value).length <= 100, { message: 'Too many custom fields' });

const sourceSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[\p{L}\p{N} _.-]+$/u, {
    message: 'Letters, digits, spaces, dots, dashes and underscores',
  });

const contactFields = {
  firstName: optionalText(100),
  lastName: optionalText(100),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  whatsappPhone: z.string().max(40).nullable().optional(),
  jobTitle: optionalText(150),
  ownerUserId: z.uuid().nullable().optional(),
  source: sourceSchema.optional(),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  customFields: customFieldsInput.optional(),
  tagIds: tagIdsSchema.optional(),
};

export const createContactInputSchema = z.object({
  ...contactFields,
  /** Primary company. */
  companyId: z.uuid().nullable().optional(),
});
export const updateContactInputSchema = z.object(contactFields);

export type CreateContactInput = z.input<typeof createContactInputSchema>;
export type UpdateContactInput = z.input<typeof updateContactInputSchema>;

export const CONTACT_SORTS = [
  'created_desc',
  'created_asc',
  'updated_desc',
  'name_asc',
  'name_desc',
] as const;

export const contactListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  ownerUserId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  source: z.string().trim().max(50).optional(),
  tagId: z.uuid().optional(),
  companyId: z.uuid().optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(CONTACT_SORTS).default('created_desc'),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema> & {
  /** `cf.<key>` equality filters. */
  customFields?: Record<string, string> | undefined;
};

export interface ContactSummary {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  jobTitle: string | null;
  source: string;
  lifecycleStage: CrmContact['lifecycleStage'];
  status: CrmContact['status'];
  ownerUserId: string | null;
  ownerName: string | null;
  primaryCompany: { id: string; name: string } | null;
  tags: TagSummary[];
  customFields: ApiCustomValues;
  createdAt: string;
  updatedAt: string;
}

export interface ContactCompanyLink {
  companyId: string;
  name: string;
  role: string | null;
  isPrimary: boolean;
}

export interface ContactDetail extends ContactSummary {
  createdByUserId: string | null;
  companies: ContactCompanyLink[];
}

const nameExpression = sql`lower(coalesce(${crmContacts.firstName}, '') || ' ' || coalesce(${crmContacts.lastName}, ''))`;

function sortSpec(sort: (typeof CONTACT_SORTS)[number]): SortSpec {
  switch (sort) {
    case 'created_desc':
      return {
        name: sort,
        expression: crmContacts.createdAt,
        direction: 'desc',
        kind: 'timestamp',
      };
    case 'created_asc':
      return { name: sort, expression: crmContacts.createdAt, direction: 'asc', kind: 'timestamp' };
    case 'updated_desc':
      return {
        name: sort,
        expression: crmContacts.updatedAt,
        direction: 'desc',
        kind: 'timestamp',
      };
    case 'name_asc':
      return { name: sort, expression: nameExpression, direction: 'asc', kind: 'text' };
    case 'name_desc':
      return { name: sort, expression: nameExpression, direction: 'desc', kind: 'text' };
  }
}

const listColumns = {
  contact: crmContacts,
  ownerName: users.name,
  primaryCompanyId: crmCompanies.id,
  primaryCompanyName: crmCompanies.name,
};

function baseQuery(tx: TenantTx) {
  return tx
    .select({ ...listColumns })
    .from(crmContacts)
    .leftJoin(users, eq(users.id, crmContacts.ownerUserId))
    .leftJoin(
      crmContactCompanies,
      and(
        eq(crmContactCompanies.contactId, crmContacts.id),
        eq(crmContactCompanies.isPrimary, true),
      ),
    )
    .leftJoin(
      crmCompanies,
      and(eq(crmCompanies.id, crmContactCompanies.companyId), isNull(crmCompanies.deletedAt)),
    );
}

type ListRow = {
  contact: CrmContact;
  ownerName: string | null;
  primaryCompanyId: string | null;
  primaryCompanyName: string | null;
};

function toSummary(
  ctx: CrmContext,
  row: ListRow,
  fields: CustomFieldSet,
  tags: Map<string, TagSummary[]>,
): ContactSummary {
  const c = row.contact;
  return {
    id: c.id,
    displayName: displayName(c),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    whatsappPhone: c.whatsappPhone,
    jobTitle: c.jobTitle,
    source: c.source,
    lifecycleStage: c.lifecycleStage,
    status: c.status,
    ownerUserId: c.ownerUserId,
    ownerName: c.ownerUserId === null ? null : row.ownerName,
    primaryCompany:
      canRead(ctx, 'company') && row.primaryCompanyId !== null && row.primaryCompanyName !== null
        ? { id: row.primaryCompanyId, name: row.primaryCompanyName }
        : null,
    tags: tags.get(c.id) ?? [],
    customFields: fields.toApi(c.customFields),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Builds the WHERE conditions shared by the list view, bulk selection and exports. */
export async function contactFilterConditions(
  tx: TenantTx,
  ctx: CrmContext,
  query: Omit<ContactListQuery, 'limit' | 'cursor' | 'sort'>,
  fields?: CustomFieldSet,
): Promise<SQL[]> {
  const conditions: SQL[] = [
    eq(crmContacts.organizationId, ctx.organizationId),
    isNull(crmContacts.deletedAt),
  ];
  if (query.q) {
    const search = searchCondition(crmContacts.searchVector, query.q, [
      crmContacts.phone,
      crmContacts.whatsappPhone,
    ]);
    if (search) conditions.push(search);
  }
  if (query.ownerUserId === 'none') conditions.push(isNull(crmContacts.ownerUserId));
  else if (query.ownerUserId === 'me') {
    conditions.push(ctx.actor.userId ? eq(crmContacts.ownerUserId, ctx.actor.userId) : sql`false`);
  } else if (query.ownerUserId) conditions.push(eq(crmContacts.ownerUserId, query.ownerUserId));
  if (query.lifecycleStage) conditions.push(eq(crmContacts.lifecycleStage, query.lifecycleStage));
  if (query.status) conditions.push(eq(crmContacts.status, query.status));
  if (query.source) conditions.push(eq(crmContacts.source, query.source));
  if (query.tagId) {
    conditions.push(
      sql`exists (select 1 from ${crmContactTags} where ${crmContactTags.contactId} = ${crmContacts.id} and ${crmContactTags.tagId} = ${query.tagId})`,
    );
  }
  if (query.companyId) {
    conditions.push(
      sql`exists (select 1 from ${crmContactCompanies} where ${crmContactCompanies.contactId} = ${crmContacts.id} and ${crmContactCompanies.companyId} = ${query.companyId})`,
    );
  }
  if (query.createdFrom) conditions.push(gte(crmContacts.createdAt, new Date(query.createdFrom)));
  if (query.createdTo) conditions.push(lte(crmContacts.createdAt, new Date(query.createdTo)));
  if (query.customFields && Object.keys(query.customFields).length > 0) {
    const set = fields ?? (await CustomFieldSet.load(tx, ctx.organizationId, 'contact'));
    const document = set.filterDocument(query.customFields);
    if (document)
      conditions.push(sql`${crmContacts.customFields} @> ${JSON.stringify(document)}::jsonb`);
  }
  return conditions;
}

export async function listContacts(
  tx: TenantTx,
  ctx: CrmContext,
  query: ContactListQuery,
): Promise<Page<ContactSummary>> {
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'contact');
  const conditions = await contactFilterConditions(tx, ctx, query, fields);
  const spec = sortSpec(query.sort);
  const after = afterCursor(spec, crmContacts.id, query.cursor);
  if (after) conditions.push(after);
  const rows = await tx
    .select({ ...listColumns, id: crmContacts.id, sortValue: sortValue(spec) })
    .from(crmContacts)
    .leftJoin(users, eq(users.id, crmContacts.ownerUserId))
    .leftJoin(
      crmContactCompanies,
      and(
        eq(crmContactCompanies.contactId, crmContacts.id),
        eq(crmContactCompanies.isPrimary, true),
      ),
    )
    .leftJoin(
      crmCompanies,
      and(eq(crmCompanies.id, crmContactCompanies.companyId), isNull(crmCompanies.deletedAt)),
    )
    .where(and(...conditions))
    .orderBy(...orderFor(spec, crmContacts.id))
    .limit(query.limit + 1);
  const tags = await tagsForRecords(
    tx,
    'contact',
    rows.slice(0, query.limit).map((row) => row.id),
  );
  return keysetPage(spec, rows, query.limit, (row) => toSummary(ctx, row, fields, tags));
}

export async function getContact(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<ContactDetail> {
  const [row] = await baseQuery(tx).where(
    and(
      eq(crmContacts.id, id),
      eq(crmContacts.organizationId, ctx.organizationId),
      isNull(crmContacts.deletedAt),
    ),
  );
  if (!row) throw new NotFoundError('Contact');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'contact');
  const tags = await tagsForRecords(tx, 'contact', [id]);
  const companies = !canRead(ctx, 'company')
    ? []
    : await tx
        .select({
          companyId: crmContactCompanies.companyId,
          name: crmCompanies.name,
          role: crmContactCompanies.role,
          isPrimary: crmContactCompanies.isPrimary,
        })
        .from(crmContactCompanies)
        .innerJoin(crmCompanies, eq(crmCompanies.id, crmContactCompanies.companyId))
        .where(and(eq(crmContactCompanies.contactId, id), isNull(crmCompanies.deletedAt)))
        .orderBy(sql`${crmContactCompanies.isPrimary} desc`, asc(crmCompanies.name))
        .limit(100);
  return {
    ...toSummary(ctx, row, fields, tags),
    createdByUserId: row.contact.createdByUserId,
    companies,
  };
}

interface NormalizedContactFields {
  email?: string | null;
  phone?: string | null;
  whatsappPhone?: string | null;
}

function normalizeChannels(
  ctx: CrmContext,
  input: {
    email?: string | null | undefined;
    phone?: string | null | undefined;
    whatsappPhone?: string | null | undefined;
  },
): NormalizedContactFields {
  const out: NormalizedContactFields = {};
  const blank = (value: string | null | undefined) => value === null || value?.trim() === '';
  if (input.email !== undefined)
    out.email = blank(input.email) ? null : normalizeEmail(input.email ?? '');
  if (input.phone !== undefined) {
    out.phone = blank(input.phone)
      ? null
      : normalizePhone(input.phone ?? '', ctx.countryCode, 'phone');
  }
  if (input.whatsappPhone !== undefined) {
    out.whatsappPhone = blank(input.whatsappPhone)
      ? null
      : normalizePhone(input.whatsappPhone ?? '', ctx.countryCode, 'whatsappPhone');
  }
  return out;
}

function assertIdentity(contact: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsappPhone: string | null;
}): void {
  if (
    !contact.firstName &&
    !contact.lastName &&
    !contact.email &&
    !contact.phone &&
    !contact.whatsappPhone
  ) {
    throw new ValidationError('A contact needs a name, email or phone number', [
      { path: 'firstName', message: 'Enter a name, email or phone number' },
    ]);
  }
}

function translateContactConflict(error: unknown): never {
  if (isUniqueViolation(error, 'crm_contacts_org_email_unique')) {
    throw new ConflictError('A contact with this email already exists', {
      details: [{ path: 'email', message: 'Already used by another contact' }],
    });
  }
  throw error;
}

/** Sets the primary company link (demoting any other primary link). */
export async function setPrimaryCompany(
  tx: TenantTx,
  organizationId: string,
  contactId: string,
  companyId: string | null,
): Promise<void> {
  await tx
    .update(crmContactCompanies)
    .set({ isPrimary: false })
    .where(
      and(eq(crmContactCompanies.contactId, contactId), eq(crmContactCompanies.isPrimary, true)),
    );
  if (companyId === null) return;
  await assertCompanyExists(tx, organizationId, companyId);
  await tx
    .insert(crmContactCompanies)
    .values({ organizationId, contactId, companyId, isPrimary: true })
    .onConflictDoUpdate({
      target: [crmContactCompanies.contactId, crmContactCompanies.companyId],
      set: { isPrimary: true },
    });
}

export interface CreateContactOptions {
  /** Skip the per-create capacity check when the caller already reserved capacity. */
  capacityChecked?: boolean;
  /** Emit tag events (default true). */
  emitTagEvents?: boolean;
}

export async function createContact(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: CreateContactInput,
  options: CreateContactOptions = {},
): Promise<ContactDetail> {
  const input = createContactInputSchema.parse(rawInput);
  const channels = normalizeChannels(ctx, input);
  const values = {
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    email: channels.email ?? null,
    phone: channels.phone ?? null,
    whatsappPhone: channels.whatsappPhone ?? null,
  };
  assertIdentity(values);
  const ownerUserId = input.ownerUserId === undefined ? ctx.actor.userId : input.ownerUserId;
  if (ownerUserId !== null)
    await assertActiveMember(tx, ctx.organizationId, ownerUserId, 'ownerUserId');
  const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'contact');
  const customFields = await fields.apply(tx, ctx, input.customFields, null);
  if (input.companyId) await assertCompanyExists(tx, ctx.organizationId, input.companyId);
  if (!options.capacityChecked) await assertContactCapacity(tx, ctx.organizationId, 1);

  let contact: CrmContact | undefined;
  try {
    [contact] = await tx
      .insert(crmContacts)
      .values({
        organizationId: ctx.organizationId,
        ...values,
        jobTitle: input.jobTitle ?? null,
        ownerUserId,
        source: input.source ?? 'manual',
        lifecycleStage: input.lifecycleStage ?? 'lead',
        status: input.status ?? 'active',
        customFields,
        createdByUserId: ctx.actor.userId,
      })
      .returning();
  } catch (error) {
    translateContactConflict(error);
  }
  if (!contact) throw new Error('contact insert returned no row');
  if (input.companyId) await setPrimaryCompany(tx, ctx.organizationId, contact.id, input.companyId);
  const added = input.tagIds?.length
    ? await addTags(tx, ctx.organizationId, 'contact', [contact.id], input.tagIds)
    : [];

  const meta = eventMeta(ctx);
  await emitEvent(tx, {
    ...meta,
    type: 'contact.created',
    subject: { type: 'contact', id: contact.id },
    payload: { contactId: contact.id, source: contact.source },
  });
  if (options.emitTagEvents !== false) {
    for (const pair of added) {
      await emitEvent(tx, {
        ...meta,
        type: 'contact.tag_added',
        subject: { type: 'contact', id: contact.id },
        payload: { contactId: contact.id, tagId: pair.tagId },
      });
    }
  }
  return getContact(tx, ctx, contact.id);
}

async function lockContact(tx: TenantTx, organizationId: string, id: string): Promise<CrmContact> {
  const [contact] = await tx
    .select()
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.id, id),
        eq(crmContacts.organizationId, organizationId),
        isNull(crmContacts.deletedAt),
      ),
    )
    .for('update');
  if (!contact) throw new NotFoundError('Contact');
  return contact;
}

export async function updateContact(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: UpdateContactInput,
): Promise<{ before: ContactDetail; after: ContactDetail; changedFields: string[] }> {
  const input = updateContactInputSchema.parse(rawInput);
  const current = await lockContact(tx, ctx.organizationId, id);
  const before = await getContact(tx, ctx, id);
  const channels = normalizeChannels(ctx, input);

  const set: Partial<typeof crmContacts.$inferInsert> = {};
  const changed: string[] = [];
  const assign = <K extends keyof CrmContact & keyof typeof crmContacts.$inferInsert>(
    key: K,
    value: CrmContact[K] | undefined,
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
  assign('firstName', input.firstName);
  assign('lastName', input.lastName);
  assign('email', channels.email);
  assign('phone', channels.phone);
  assign('whatsappPhone', channels.whatsappPhone);
  assign('jobTitle', input.jobTitle);
  assign('source', input.source);
  assign('lifecycleStage', input.lifecycleStage);
  assign('status', input.status);
  if (input.ownerUserId !== undefined && input.ownerUserId !== current.ownerUserId) {
    if (input.ownerUserId !== null)
      await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
    assign('ownerUserId', input.ownerUserId);
  }
  if (input.customFields !== undefined) {
    const fields = await CustomFieldSet.load(tx, ctx.organizationId, 'contact');
    assign('customFields', await fields.apply(tx, ctx, input.customFields, current.customFields));
  }
  assertIdentity({
    firstName: set.firstName === undefined ? current.firstName : set.firstName,
    lastName: set.lastName === undefined ? current.lastName : set.lastName,
    email: set.email === undefined ? current.email : set.email,
    phone: set.phone === undefined ? current.phone : set.phone,
    whatsappPhone: set.whatsappPhone === undefined ? current.whatsappPhone : set.whatsappPhone,
  });

  const tagChanges = input.tagIds
    ? await setRecordTags(tx, ctx.organizationId, 'contact', id, input.tagIds)
    : { added: [], removed: [] };
  if (tagChanges.added.length > 0 || tagChanges.removed.length > 0) changed.push('tags');

  if (changed.length > 0) {
    try {
      await tx
        .update(crmContacts)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(crmContacts.id, id), eq(crmContacts.organizationId, ctx.organizationId)));
    } catch (error) {
      translateContactConflict(error);
    }
    const meta = eventMeta(ctx);
    await emitEvent(tx, {
      ...meta,
      type: 'contact.updated',
      subject: { type: 'contact', id },
      payload: { contactId: id, changedFields: changed },
    });
    for (const tagId of tagChanges.added) {
      await emitEvent(tx, {
        ...meta,
        type: 'contact.tag_added',
        subject: { type: 'contact', id },
        payload: { contactId: id, tagId },
      });
    }
    for (const tagId of tagChanges.removed) {
      await emitEvent(tx, {
        ...meta,
        type: 'contact.tag_removed',
        subject: { type: 'contact', id },
        payload: { contactId: id, tagId },
      });
    }
  }
  const after = changed.length > 0 ? await getContact(tx, ctx, id) : before;
  return { before, after, changedFields: changed };
}

/** Soft-deletes a contact (kept for audit/retention; hidden everywhere). */
export async function deleteContact(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
): Promise<ContactDetail> {
  await lockContact(tx, ctx.organizationId, id);
  const before = await getContact(tx, ctx, id);
  await tx
    .update(crmContacts)
    .set({ deletedAt: new Date() })
    .where(and(eq(crmContacts.id, id), eq(crmContacts.organizationId, ctx.organizationId)));
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'contact.deleted',
    subject: { type: 'contact', id },
    payload: { contactId: id },
  });
  return before;
}

export const contactLinkInputSchema = z.object({
  companyId: z.uuid(),
  role: optionalText(100),
  isPrimary: z.boolean().default(false),
});

export async function linkContactCompany(
  tx: TenantTx,
  ctx: CrmContext,
  contactId: string,
  rawInput: z.input<typeof contactLinkInputSchema>,
): Promise<ContactCompanyLink[]> {
  const input = contactLinkInputSchema.parse(rawInput);
  await lockContact(tx, ctx.organizationId, contactId);
  await assertCompanyExists(tx, ctx.organizationId, input.companyId);
  if (input.isPrimary) {
    await setPrimaryCompany(tx, ctx.organizationId, contactId, input.companyId);
  }
  await tx
    .insert(crmContactCompanies)
    .values({
      organizationId: ctx.organizationId,
      contactId,
      companyId: input.companyId,
      role: input.role ?? null,
      isPrimary: input.isPrimary,
    })
    .onConflictDoUpdate({
      target: [crmContactCompanies.contactId, crmContactCompanies.companyId],
      set: { role: input.role ?? null, isPrimary: input.isPrimary },
    });
  return (await getContact(tx, ctx, contactId)).companies;
}

export async function unlinkContactCompany(
  tx: TenantTx,
  ctx: CrmContext,
  contactId: string,
  companyId: string,
): Promise<void> {
  await lockContact(tx, ctx.organizationId, contactId);
  const removed = await tx
    .delete(crmContactCompanies)
    .where(
      and(
        eq(crmContactCompanies.organizationId, ctx.organizationId),
        eq(crmContactCompanies.contactId, contactId),
        eq(crmContactCompanies.companyId, companyId),
      ),
    )
    .returning({ companyId: crmContactCompanies.companyId });
  if (removed.length === 0) throw new NotFoundError('Company link');
}

export const CONTACT_BULK_ACTIONS = [
  'delete',
  'assign_owner',
  'add_tags',
  'remove_tags',
  'set_lifecycle',
  'set_status',
] as const;

export const contactBulkInputSchema = z.discriminatedUnion('action', [
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
  z.object({
    action: z.literal('set_lifecycle'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    lifecycleStage: z.enum(LIFECYCLE_STAGES),
  }),
  z.object({
    action: z.literal('set_status'),
    ids: z.array(z.uuid()).min(1).max(MAX_BULK_IDS),
    status: z.enum(CONTACT_STATUSES),
  }),
]);
export type ContactBulkInput = z.infer<typeof contactBulkInputSchema>;

/**
 * Applies one action to many contacts. Only live contacts of this organization are affected;
 * ids that do not match (other tenants, deleted, guessed) are silently skipped and reported
 * through the `affected` count.
 */
export async function bulkUpdateContacts(
  tx: TenantTx,
  ctx: CrmContext,
  input: ContactBulkInput,
): Promise<{ affected: number; ids: string[] }> {
  const targets = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.organizationId, ctx.organizationId),
        isNull(crmContacts.deletedAt),
        inArray(crmContacts.id, [...new Set(input.ids)]),
      ),
    )
    .orderBy(asc(crmContacts.id))
    .for('update');
  const ids = targets.map((row) => row.id);
  if (ids.length === 0) return { affected: 0, ids };
  const meta = eventMeta(ctx);
  const scope = and(
    eq(crmContacts.organizationId, ctx.organizationId),
    inArray(crmContacts.id, ids),
  );
  const updated = async (changedFields: string[]) => {
    for (const id of ids) {
      await emitEvent(tx, {
        ...meta,
        type: 'contact.updated',
        subject: { type: 'contact', id },
        payload: { contactId: id, changedFields },
      });
    }
  };

  switch (input.action) {
    case 'delete':
      await tx.update(crmContacts).set({ deletedAt: new Date() }).where(scope);
      for (const id of ids) {
        await emitEvent(tx, {
          ...meta,
          type: 'contact.deleted',
          subject: { type: 'contact', id },
          payload: { contactId: id },
        });
      }
      break;
    case 'assign_owner':
      if (input.ownerUserId !== null) {
        await assertActiveMember(tx, ctx.organizationId, input.ownerUserId, 'ownerUserId');
      }
      await tx.update(crmContacts).set({ ownerUserId: input.ownerUserId }).where(scope);
      await updated(['ownerUserId']);
      break;
    case 'set_lifecycle':
      await tx.update(crmContacts).set({ lifecycleStage: input.lifecycleStage }).where(scope);
      await updated(['lifecycleStage']);
      break;
    case 'set_status':
      await tx.update(crmContacts).set({ status: input.status }).where(scope);
      await updated(['status']);
      break;
    case 'add_tags': {
      const added = await addTags(tx, ctx.organizationId, 'contact', ids, input.tagIds);
      for (const pair of added) {
        await emitEvent(tx, {
          ...meta,
          type: 'contact.tag_added',
          subject: { type: 'contact', id: pair.recordId },
          payload: { contactId: pair.recordId, tagId: pair.tagId },
        });
      }
      break;
    }
    case 'remove_tags': {
      const removed = await removeTags(tx, ctx.organizationId, 'contact', ids, input.tagIds);
      for (const pair of removed) {
        await emitEvent(tx, {
          ...meta,
          type: 'contact.tag_removed',
          subject: { type: 'contact', id: pair.recordId },
          payload: { contactId: pair.recordId, tagId: pair.tagId },
        });
      }
      break;
    }
  }
  return { affected: ids.length, ids };
}

/** Finds a live contact by normalized email (duplicate detection for imports). */
export async function findContactByEmail(
  tx: TenantTx,
  organizationId: string,
  email: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.organizationId, organizationId),
        eq(crmContacts.email, email),
        isNull(crmContacts.deletedAt),
      ),
    );
  return row?.id ?? null;
}
