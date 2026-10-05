import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { crmContacts, crmDeals } from './crm';
import { organizations } from './organizations';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

export const FORM_STATUSES = ['active', 'archived'] as const;

/** A form. Its behaviour lives in versions: one editable draft and at most one published. */
export const forms = pgTable(
  'forms',
  {
    id: primaryId(),
    organizationId: orgId(),
    name: text().notNull(),
    /** Globally unique public slug (`/f/<slug>`). */
    slug: text().notNull(),
    status: text({ enum: FORM_STATUSES }).notNull().default('active'),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('forms_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('forms_slug_unique').on(t.slug),
    index('forms_org_idx').on(t.organizationId, t.status),
    check('forms_name_check', sql`char_length(${t.name}) between 1 and 120`),
    check('forms_slug_check', sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$'`),
    check('forms_status_check', sql`${t.status} in ('active', 'archived')`),
    tenantIsolationPolicy(),
  ],
);

export const FORM_VERSION_STATUSES = ['draft', 'published', 'retired'] as const;
export type FormVersionStatus = (typeof FORM_VERSION_STATUSES)[number];

/**
 * A snapshot of a form's fields and settings. Published and retired versions are immutable;
 * submissions keep pointing at the version they were made with.
 */
export const formVersions = pgTable(
  'form_versions',
  {
    id: primaryId(),
    organizationId: orgId(),
    formId: uuid().notNull(),
    number: integer().notNull(),
    status: text({ enum: FORM_VERSION_STATUSES }).notNull().default('draft'),
    /** Success message, redirect, tags, owner, deal creation, captcha (validated by the service). */
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    publishedAt: timestamp({ withTimezone: true }),
    publishedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('form_versions_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('form_versions_form_number_unique').on(t.formId, t.number),
    uniqueIndex('form_versions_one_draft')
      .on(t.formId)
      .where(sql`${t.status} = 'draft'`),
    uniqueIndex('form_versions_one_published')
      .on(t.formId)
      .where(sql`${t.status} = 'published'`),
    foreignKey({
      name: 'form_versions_form_fk',
      columns: [t.formId, t.organizationId],
      foreignColumns: [forms.id, forms.organizationId],
    }).onDelete('cascade'),
    check('form_versions_status_check', sql`${t.status} in ('draft', 'published', 'retired')`),
    check('form_versions_number_check', sql`${t.number} >= 1`),
    tenantIsolationPolicy(),
  ],
);

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'date',
  'select',
  'multi_select',
  'checkbox',
  'radio',
  'hidden',
  'consent',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** One field of a version, in display order. */
export const formFields = pgTable(
  'form_fields',
  {
    id: primaryId(),
    organizationId: orgId(),
    versionId: uuid().notNull(),
    /** Stable answer key (`email`, `company_size`…). */
    key: text().notNull(),
    type: text({ enum: FORM_FIELD_TYPES }).notNull(),
    label: text().notNull(),
    required: boolean().notNull().default(false),
    position: integer().notNull(),
    placeholder: text(),
    helpText: text(),
    /** `[{ value, label }]` for select, multi-select and radio. */
    options: jsonb().$type<{ value: string; label: string }[]>().notNull().default([]),
    /** `{ min, max, maxLength, maxSelections }` as applicable. */
    validation: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Hidden fields: value used when the URL does not provide one. */
    defaultValue: text(),
    /** CRM mapping target (`contact.email`, `contact.custom.<key>`…), allow-listed. */
    target: text(),
  },
  (t) => [
    uniqueIndex('form_fields_version_key_unique').on(t.versionId, t.key),
    index('form_fields_version_idx').on(t.versionId, t.position),
    foreignKey({
      name: 'form_fields_version_fk',
      columns: [t.versionId, t.organizationId],
      foreignColumns: [formVersions.id, formVersions.organizationId],
    }).onDelete('cascade'),
    check('form_fields_key_check', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('form_fields_label_check', sql`char_length(${t.label}) between 1 and 200`),
    check(
      'form_fields_type_check',
      sql`${t.type} in ('text', 'textarea', 'email', 'phone', 'number', 'date', 'select', 'multi_select', 'checkbox', 'radio', 'hidden', 'consent')`,
    ),
    tenantIsolationPolicy(),
  ],
);

export const SUBMISSION_STATUSES = ['accepted', 'spam'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** A submitted form. Answers are validated against the version's fields before storage. */
export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: primaryId(),
    organizationId: orgId(),
    formId: uuid().notNull(),
    versionId: uuid().notNull(),
    answers: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text({ enum: SUBMISSION_STATUSES }).notNull(),
    spamReasons: jsonb().$type<string[]>().notNull().default([]),
    /** What CRM processing did or could not do (e.g. contact limit reached). */
    processingNotes: jsonb().$type<string[]>().notNull().default([]),
    contactId: uuid(),
    dealId: uuid(),
    /** The render token: one submission per rendered form (double-submit protection). */
    idempotencyKey: text().notNull(),
    userAgent: text(),
    submittedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('form_submissions_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('form_submissions_form_key_unique').on(t.formId, t.idempotencyKey),
    index('form_submissions_form_idx').on(t.formId, t.submittedAt.desc(), t.id.desc()),
    index('form_submissions_contact_idx').on(t.contactId),
    /** Reports: submissions per period across forms. */
    index('form_submissions_org_submitted_idx').on(t.organizationId, t.submittedAt),
    foreignKey({
      name: 'form_submissions_form_fk',
      columns: [t.formId, t.organizationId],
      foreignColumns: [forms.id, forms.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'form_submissions_version_fk',
      columns: [t.versionId, t.organizationId],
      foreignColumns: [formVersions.id, formVersions.organizationId],
    }),
    foreignKey({
      name: 'form_submissions_contact_fk',
      columns: [t.contactId, t.organizationId],
      foreignColumns: [crmContacts.id, crmContacts.organizationId],
    }),
    foreignKey({
      name: 'form_submissions_deal_fk',
      columns: [t.dealId, t.organizationId],
      foreignColumns: [crmDeals.id, crmDeals.organizationId],
    }),
    check('form_submissions_status_check', sql`${t.status} in ('accepted', 'spam')`),
    tenantIsolationPolicy(),
  ],
);

export type Form = typeof forms.$inferSelect;
export type FormVersion = typeof formVersions.$inferSelect;
export type FormField = typeof formFields.$inferSelect;
export type FormSubmission = typeof formSubmissions.$inferSelect;
