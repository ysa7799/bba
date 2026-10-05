import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { organizations } from './organizations';
import { users } from './users';

/** Postgres full-text search vector (generated columns only; never written by the app). */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

const deletedAt = () => timestamp({ withTimezone: true });

/** Custom field values keyed by field id; validated against `crm_custom_fields`. */
const customFieldValues = () => jsonb().$type<Record<string, unknown>>().notNull().default({});

function searchVector(...parts: SQL[]) {
  return tsvector().generatedAlwaysAs(
    sql`to_tsvector('simple', ${sql.join(
      parts.map((part) => sql`coalesce(${part}, '')`),
      sql` || ' ' || `,
    )})`,
  );
}

export const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'qualified',
  'opportunity',
  'customer',
  'evangelist',
  'other',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const crmCompanies = pgTable(
  'crm_companies',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    /** Normalized (lower-case, no scheme or www.) primary domain. */
    domain: text(),
    phone: text(),
    website: text(),
    industry: text(),
    employeeCount: integer(),
    city: text(),
    countryCode: char({ length: 2 }),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    customFields: customFieldValues(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: deletedAt(),
    ...timestamps(),
    searchVector: searchVector(sql`name`, sql`domain`, sql`phone`, sql`industry`, sql`city`),
  },
  (t) => [
    uniqueIndex('crm_companies_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('crm_companies_org_domain_unique')
      .on(t.organizationId, t.domain)
      .where(sql`${t.domain} is not null and ${t.deletedAt} is null`),
    index('crm_companies_org_created_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('crm_companies_org_name_idx').on(t.organizationId, sql`lower(${t.name})`, t.id),
    index('crm_companies_search_idx').using('gin', t.searchVector),
    index('crm_companies_custom_fields_idx').using('gin', sql`${t.customFields} jsonb_path_ops`),
    check('crm_companies_name_check', sql`char_length(${t.name}) between 1 and 200`),
    check(
      'crm_companies_employee_count_check',
      sql`${t.employeeCount} is null or ${t.employeeCount} >= 0`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const CONTACT_STATUSES = ['active', 'inactive'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const crmContacts = pgTable(
  'crm_contacts',
  {
    id: primaryId(),
    organizationId: orgId(),
    firstName: text(),
    lastName: text(),
    /** Normalized (trimmed, lower-case) email. */
    email: text(),
    /** E.164. */
    phone: text(),
    /** E.164 number used for WhatsApp (may differ from `phone`). */
    whatsappPhone: text(),
    jobTitle: text(),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    source: text().notNull().default('manual'),
    lifecycleStage: text({ enum: LIFECYCLE_STAGES }).notNull().default('lead'),
    status: text({ enum: CONTACT_STATUSES }).notNull().default('active'),
    customFields: customFieldValues(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: deletedAt(),
    ...timestamps(),
    searchVector: searchVector(
      sql`first_name`,
      sql`last_name`,
      sql`email`,
      sql`phone`,
      sql`whatsapp_phone`,
      sql`job_title`,
    ),
  },
  (t) => [
    uniqueIndex('crm_contacts_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('crm_contacts_org_email_unique')
      .on(t.organizationId, t.email)
      .where(sql`${t.email} is not null and ${t.deletedAt} is null`),
    index('crm_contacts_org_created_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('crm_contacts_org_name_idx').on(
      t.organizationId,
      sql`lower(coalesce(${t.firstName}, '') || ' ' || coalesce(${t.lastName}, ''))`,
      t.id,
    ),
    index('crm_contacts_org_phone_idx').on(t.organizationId, t.phone),
    index('crm_contacts_org_owner_idx').on(t.organizationId, t.ownerUserId),
    index('crm_contacts_search_idx').using('gin', t.searchVector),
    index('crm_contacts_custom_fields_idx').using('gin', sql`${t.customFields} jsonb_path_ops`),
    check(
      'crm_contacts_identity_check',
      sql`coalesce(${t.firstName}, ${t.lastName}, ${t.email}, ${t.phone}, ${t.whatsappPhone}) is not null`,
    ),
    check(
      'crm_contacts_email_check',
      sql`${t.email} is null or ${t.email} = lower(btrim(${t.email}))`,
    ),
    check(
      'crm_contacts_phone_check',
      sql`${t.phone} is null or ${t.phone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      'crm_contacts_whatsapp_check',
      sql`${t.whatsappPhone} is null or ${t.whatsappPhone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      'crm_contacts_lifecycle_check',
      sql`${t.lifecycleStage} in ('subscriber', 'lead', 'qualified', 'opportunity', 'customer', 'evangelist', 'other')`,
    ),
    check('crm_contacts_status_check', sql`${t.status} in ('active', 'inactive')`),
    tenantIsolationPolicy(),
  ],
);

/** Contact ↔ company relationships (one primary company per contact). */
export const crmContactCompanies = pgTable(
  'crm_contact_companies',
  {
    organizationId: orgId(),
    contactId: uuid().notNull(),
    companyId: uuid().notNull(),
    role: text(),
    isPrimary: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.companyId] }),
    uniqueIndex('crm_contact_companies_one_primary')
      .on(t.contactId)
      .where(sql`${t.isPrimary}`),
    index('crm_contact_companies_company_idx').on(t.companyId),
    foreignKey({
      name: 'crm_contact_companies_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'crm_contact_companies_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const crmPipelines = pgTable(
  'crm_pipelines',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('crm_pipelines_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('crm_pipelines_org_name_unique')
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex('crm_pipelines_one_default')
      .on(t.organizationId)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
    check('crm_pipelines_name_check', sql`char_length(${t.name}) between 1 and 100`),
    tenantIsolationPolicy(),
  ],
);

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const crmPipelineStages = pgTable(
  'crm_pipeline_stages',
  {
    id: primaryId(),
    organizationId: orgId(),
    pipelineId: uuid().notNull(),
    name: text().notNull(),
    position: integer().notNull(),
    /** Win probability 0–100 used for weighted pipeline value. */
    probability: integer().notNull().default(0),
    kind: text({ enum: STAGE_KINDS }).notNull().default('open'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('crm_pipeline_stages_id_org_unique').on(t.id, t.organizationId),
    // Lets deals reference (stage, pipeline) so a deal's stage always belongs to its pipeline.
    uniqueIndex('crm_pipeline_stages_id_pipeline_unique').on(t.id, t.pipelineId),
    uniqueIndex('crm_pipeline_stages_pipeline_name_unique').on(t.pipelineId, sql`lower(${t.name})`),
    index('crm_pipeline_stages_pipeline_position_idx').on(t.pipelineId, t.position),
    foreignKey({
      name: 'crm_pipeline_stages_pipeline_fk',
      columns: [t.pipelineId, t.organizationId],
      foreignColumns: [crmPipelines.id, crmPipelines.organizationId],
    }).onDelete('cascade'),
    check('crm_pipeline_stages_probability_check', sql`${t.probability} between 0 and 100`),
    check('crm_pipeline_stages_kind_check', sql`${t.kind} in ('open', 'won', 'lost')`),
    check('crm_pipeline_stages_name_check', sql`char_length(${t.name}) between 1 and 100`),
    tenantIsolationPolicy(),
  ],
);

export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const crmDeals = pgTable(
  'crm_deals',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    pipelineId: uuid().notNull(),
    stageId: uuid().notNull(),
    contactId: uuid(),
    companyId: uuid(),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    valueMinor: bigint({ mode: 'bigint' }),
    currency: char({ length: 3 }).notNull(),
    /** Overrides the stage probability when set. */
    probability: integer(),
    expectedCloseDate: date({ mode: 'string' }),
    status: text({ enum: DEAL_STATUSES }).notNull().default('open'),
    closedAt: timestamp({ withTimezone: true }),
    lostReason: text(),
    stageEnteredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Ordering within a stage on the board (fractional positions). */
    position: doublePrecision().notNull().default(0),
    customFields: customFieldValues(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: deletedAt(),
    ...timestamps(),
    searchVector: searchVector(sql`name`, sql`lost_reason`),
  },
  (t) => [
    uniqueIndex('crm_deals_id_org_unique').on(t.id, t.organizationId),
    index('crm_deals_org_created_idx').on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index('crm_deals_board_idx').on(t.pipelineId, t.stageId, t.position),
    index('crm_deals_contact_idx').on(t.contactId),
    index('crm_deals_company_idx').on(t.companyId),
    index('crm_deals_org_status_idx').on(t.organizationId, t.status),
    /** Reports: deals won/lost per period. */
    index('crm_deals_org_closed_idx')
      .on(t.organizationId, t.closedAt)
      .where(sql`${t.closedAt} is not null`),
    index('crm_deals_search_idx').using('gin', t.searchVector),
    index('crm_deals_custom_fields_idx').using('gin', sql`${t.customFields} jsonb_path_ops`),
    foreignKey({
      name: 'crm_deals_pipeline_fk',
      columns: [t.pipelineId, t.organizationId],
      foreignColumns: [crmPipelines.id, crmPipelines.organizationId],
    }),
    foreignKey({
      name: 'crm_deals_stage_fk',
      columns: [t.stageId, t.pipelineId],
      foreignColumns: [crmPipelineStages.id, crmPipelineStages.pipelineId],
    }),
    foreignKey({
      name: 'crm_deals_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'crm_deals_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }),
    check('crm_deals_name_check', sql`char_length(${t.name}) between 1 and 200`),
    check('crm_deals_value_check', sql`${t.valueMinor} is null or ${t.valueMinor} >= 0`),
    check('crm_deals_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'crm_deals_probability_check',
      sql`${t.probability} is null or ${t.probability} between 0 and 100`,
    ),
    check('crm_deals_status_check', sql`${t.status} in ('open', 'won', 'lost')`),
    tenantIsolationPolicy(),
  ],
);

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export const TASK_STATUSES = ['open', 'completed'] as const;

export const crmTasks = pgTable(
  'crm_tasks',
  {
    id: primaryId(),
    organizationId: orgId(),
    title: text().notNull(),
    description: text(),
    dueAt: timestamp({ withTimezone: true }),
    priority: text({ enum: TASK_PRIORITIES }).notNull().default('normal'),
    status: text({ enum: TASK_STATUSES }).notNull().default('open'),
    completedAt: timestamp({ withTimezone: true }),
    assigneeUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    contactId: uuid(),
    companyId: uuid(),
    dealId: uuid(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    index('crm_tasks_org_status_due_idx').on(t.organizationId, t.status, t.dueAt),
    index('crm_tasks_assignee_idx').on(t.organizationId, t.assigneeUserId, t.status),
    index('crm_tasks_contact_idx').on(t.contactId),
    index('crm_tasks_deal_idx').on(t.dealId),
    index('crm_tasks_org_completed_idx')
      .on(t.organizationId, t.completedAt)
      .where(sql`${t.completedAt} is not null`),
    foreignKey({
      name: 'crm_tasks_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'crm_tasks_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }),
    foreignKey({
      name: 'crm_tasks_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }),
    check('crm_tasks_title_check', sql`char_length(${t.title}) between 1 and 300`),
    check('crm_tasks_priority_check', sql`${t.priority} in ('low', 'normal', 'high')`),
    check('crm_tasks_status_check', sql`${t.status} in ('open', 'completed')`),
    tenantIsolationPolicy(),
  ],
);

/** Plain-text notes attached to exactly one record. */
export const crmNotes = pgTable(
  'crm_notes',
  {
    id: primaryId(),
    organizationId: orgId(),
    body: text().notNull(),
    contactId: uuid(),
    companyId: uuid(),
    dealId: uuid(),
    authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    deletedAt: deletedAt(),
    ...timestamps(),
  },
  (t) => [
    index('crm_notes_contact_idx').on(t.contactId, t.createdAt),
    index('crm_notes_company_idx').on(t.companyId, t.createdAt),
    index('crm_notes_deal_idx').on(t.dealId, t.createdAt),
    foreignKey({
      name: 'crm_notes_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'crm_notes_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'crm_notes_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }).onDelete('cascade'),
    check('crm_notes_body_check', sql`char_length(${t.body}) between 1 and 20000`),
    check(
      'crm_notes_one_parent_check',
      sql`num_nonnulls(${t.contactId}, ${t.companyId}, ${t.dealId}) = 1`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const crmTags = pgTable(
  'crm_tags',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    color: text().notNull().default('slate'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('crm_tags_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('crm_tags_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    check('crm_tags_name_check', sql`char_length(${t.name}) between 1 and 50`),
    check('crm_tags_color_check', sql`${t.color} ~ '^[a-z]{3,10}$'`),
    tenantIsolationPolicy(),
  ],
);

const tagFk = (name: string, tagId: AnyPgColumn, organizationId: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tagId, organizationId],
    foreignColumns: [crmTags.id, crmTags.organizationId],
  }).onDelete('cascade');

export const crmContactTags = pgTable(
  'crm_contact_tags',
  {
    organizationId: orgId(),
    tagId: uuid().notNull(),
    contactId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId] }),
    index('crm_contact_tags_tag_idx').on(t.tagId),
    tagFk('crm_contact_tags_tag_fk', t.tagId, t.organizationId),
    foreignKey({
      name: 'crm_contact_tags_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const crmCompanyTags = pgTable(
  'crm_company_tags',
  {
    organizationId: orgId(),
    tagId: uuid().notNull(),
    companyId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.tagId] }),
    index('crm_company_tags_tag_idx').on(t.tagId),
    tagFk('crm_company_tags_tag_fk', t.tagId, t.organizationId),
    foreignKey({
      name: 'crm_company_tags_company_fk',
      columns: [t.companyId, t.organizationId],
      foreignColumns: [crmCompanies.id, crmCompanies.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const crmDealTags = pgTable(
  'crm_deal_tags',
  {
    organizationId: orgId(),
    tagId: uuid().notNull(),
    dealId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.dealId, t.tagId] }),
    index('crm_deal_tags_tag_idx').on(t.tagId),
    tagFk('crm_deal_tags_tag_fk', t.tagId, t.organizationId),
    foreignKey({
      name: 'crm_deal_tags_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }).onDelete('cascade'),
    tenantIsolationPolicy(),
  ],
);

export const CUSTOM_FIELD_ENTITIES = ['contact', 'company', 'deal'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'select',
  'multi_select',
  'email',
  'phone',
  'url',
  'user',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const crmCustomFields = pgTable(
  'crm_custom_fields',
  {
    id: primaryId(),
    organizationId: orgId(),
    entityType: text({ enum: CUSTOM_FIELD_ENTITIES }).notNull(),
    /** Stable machine key (for API, import mapping and automation). */
    key: text().notNull(),
    label: text().notNull(),
    type: text({ enum: CUSTOM_FIELD_TYPES }).notNull(),
    /** For select/multi_select: [{ value, label }]. */
    options: jsonb().$type<{ value: string; label: string }[]>().notNull().default([]),
    required: boolean().notNull().default(false),
    helpText: text(),
    position: integer().notNull().default(0),
    archivedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('crm_custom_fields_org_entity_key_unique').on(
      t.organizationId,
      t.entityType,
      t.key,
    ),
    index('crm_custom_fields_org_entity_idx').on(t.organizationId, t.entityType, t.position),
    check('crm_custom_fields_key_check', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,49}$'`),
    check('crm_custom_fields_label_check', sql`char_length(${t.label}) between 1 and 100`),
    check('crm_custom_fields_entity_check', sql`${t.entityType} in ('contact', 'company', 'deal')`),
    tenantIsolationPolicy(),
  ],
);

export const IMPORT_ENTITIES = ['contact', 'company'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];
export const IMPORT_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'completed',
  'failed',
  'canceled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const DUPLICATE_POLICIES = ['skip', 'update'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

/** A CSV import: staged rows, a column mapping and progress counters (processed by the worker). */
export const crmImports = pgTable(
  'crm_imports',
  {
    id: primaryId(),
    organizationId: orgId(),
    entityType: text({ enum: IMPORT_ENTITIES }).notNull(),
    status: text({ enum: IMPORT_STATUSES }).notNull().default('uploaded'),
    fileName: text().notNull(),
    headers: jsonb().$type<string[]>().notNull(),
    /** Column index (as string) → target field ("email", "first_name", "cf:<key>", …). */
    mapping: jsonb().$type<Record<string, string>>().notNull().default({}),
    duplicatePolicy: text({ enum: DUPLICATE_POLICIES }).notNull().default('skip'),
    totalRows: integer().notNull().default(0),
    processedRows: integer().notNull().default(0),
    createdCount: integer().notNull().default(0),
    updatedCount: integer().notNull().default(0),
    skippedCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    failureReason: text(),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('crm_imports_id_org_unique').on(t.id, t.organizationId),
    index('crm_imports_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    check(
      'crm_imports_status_check',
      sql`${t.status} in ('uploaded', 'queued', 'processing', 'completed', 'failed', 'canceled')`,
    ),
    check('crm_imports_entity_check', sql`${t.entityType} in ('contact', 'company')`),
    check('crm_imports_duplicate_policy_check', sql`${t.duplicatePolicy} in ('skip', 'update')`),
    tenantIsolationPolicy(),
  ],
);

export const IMPORT_ROW_STATUSES = ['pending', 'created', 'updated', 'skipped', 'failed'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const crmImportRows = pgTable(
  'crm_import_rows',
  {
    organizationId: orgId(),
    importId: uuid().notNull(),
    /** 1-based data row number (excluding the header row). */
    rowNumber: integer().notNull(),
    values: jsonb().$type<string[]>().notNull(),
    status: text({ enum: IMPORT_ROW_STATUSES }).notNull().default('pending'),
    error: text(),
    recordId: uuid(),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.rowNumber] }),
    index('crm_import_rows_status_idx').on(t.importId, t.status),
    foreignKey({
      name: 'crm_import_rows_import_fk',
      columns: [t.importId, t.organizationId],
      foreignColumns: [crmImports.id, crmImports.organizationId],
    }).onDelete('cascade'),
    check(
      'crm_import_rows_status_check',
      sql`${t.status} in ('pending', 'created', 'updated', 'skipped', 'failed')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const EXPORT_ENTITIES = ['contact', 'company', 'deal'] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];
export const EXPORT_STATUSES = ['queued', 'processing', 'completed', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/**
 * An asynchronous CSV export. The generated file is held here until it expires (object storage
 * replaces the inline content once file storage ships) and only its creator may download it.
 */
export const crmExports = pgTable(
  'crm_exports',
  {
    id: primaryId(),
    organizationId: orgId(),
    entityType: text({ enum: EXPORT_ENTITIES }).notNull(),
    status: text({ enum: EXPORT_STATUSES }).notNull().default('queued'),
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    rowCount: integer(),
    content: text(),
    contentBytes: integer(),
    failureReason: text(),
    downloadCount: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index('crm_exports_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('crm_exports_expires_idx').on(t.expiresAt),
    check(
      'crm_exports_status_check',
      sql`${t.status} in ('queued', 'processing', 'completed', 'failed', 'expired')`,
    ),
    check('crm_exports_entity_check', sql`${t.entityType} in ('contact', 'company', 'deal')`),
    tenantIsolationPolicy(),
  ],
);

export type CrmContact = typeof crmContacts.$inferSelect;
export type CrmCompany = typeof crmCompanies.$inferSelect;
export type CrmPipeline = typeof crmPipelines.$inferSelect;
export type CrmPipelineStage = typeof crmPipelineStages.$inferSelect;
export type CrmDeal = typeof crmDeals.$inferSelect;
export type CrmTask = typeof crmTasks.$inferSelect;
export type CrmNote = typeof crmNotes.$inferSelect;
export type CrmTag = typeof crmTags.$inferSelect;
export type CrmCustomField = typeof crmCustomFields.$inferSelect;
export type CrmImport = typeof crmImports.$inferSelect;
export type CrmExport = typeof crmExports.$inferSelect;
