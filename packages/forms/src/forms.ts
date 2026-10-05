import { assertWithinLimit } from '@businessos/billing';
import {
  assertActiveMember,
  assertTagsExist,
  CustomFieldSet,
  resolveStage,
  type CrmContext,
} from '@businessos/crm';
import {
  formFields,
  formSubmissions,
  forms,
  formVersions,
  isUniqueViolation,
  organizations,
  withSystem,
  withTenant,
  type Database,
  type Form,
  type FormField,
  type FormVersion,
  type TenantTx,
} from '@businessos/database';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '@businessos/shared';
import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { fieldInputSchema, toPublicField, type PublicField } from './fields';
import { mappingProblems } from './mapping';
import { formSettingsSchema, readSettings, type FormSettings } from './settings';

export const MAX_FIELDS_PER_FORM = 50;

const formSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/, 'Use 3–64 lower-case letters, digits and dashes');

export const createFormInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: formSlugSchema.optional(),
});
export const updateFormInputSchema = z
  .object({ name: z.string().trim().min(1).max(120), slug: formSlugSchema })
  .partial();
export const saveDraftInputSchema = z
  .object({
    fields: z.array(fieldInputSchema).min(1).max(MAX_FIELDS_PER_FORM),
    settings: formSettingsSchema.prefault({}),
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: 'Field keys must be unique',
        });
      }
      seen.add(field.key);
    });
    if (input.fields.every((field) => field.type === 'hidden')) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Add at least one visible field' });
    }
  });
export const formListQuerySchema = z.object({
  status: z.enum(['active', 'archived']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export type CreateFormInput = z.input<typeof createFormInputSchema>;
export type SaveDraftInput = z.input<typeof saveDraftInputSchema>;

export interface BuilderField {
  key: string;
  type: FormField['type'];
  label: string;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: { value: string; label: string }[];
  validation: Record<string, number>;
  defaultValue: string | null;
  target: string | null;
}

export interface FormVersionView {
  id: string;
  number: number;
  status: FormVersion['status'];
  settings: FormSettings;
  fields: BuilderField[];
  publishedAt: string | null;
}

export interface FormSummary {
  id: string;
  name: string;
  slug: string;
  status: Form['status'];
  publishedVersion: number | null;
  publishedAt: string | null;
  hasDraft: boolean;
  submissionCount: number;
  lastSubmissionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormDetail extends FormSummary {
  draft: FormVersionView | null;
  published: FormVersionView | null;
}

/** Fields of a brand-new form: name, email, phone and a message, mapped to the contact. */
export const DEFAULT_FIELDS: z.input<typeof fieldInputSchema>[] = [
  {
    key: 'full_name',
    type: 'text',
    label: 'Full name',
    required: true,
    target: 'contact.fullName',
  },
  { key: 'email', type: 'email', label: 'Email', required: true, target: 'contact.email' },
  { key: 'phone', type: 'phone', label: 'Phone', required: false, target: 'contact.phone' },
  { key: 'message', type: 'textarea', label: 'Message', required: false },
];

function toBuilderField(field: FormField): BuilderField {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required,
    placeholder: field.placeholder,
    helpText: field.helpText,
    options: field.options,
    validation: field.validation,
    defaultValue: field.defaultValue,
    target: field.target,
  };
}

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : 'form';
}

/** Six random base-36 characters: generated links are not guessable from the form name. */
function randomSuffix(): string {
  return [...randomBytes(6)].map((byte) => (byte % 36).toString(36)).join('');
}

async function lockForms(tx: TenantTx, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`forms:${organizationId}`}, 0))`,
  );
}

/** Enforces `forms.max` (forms that are not archived), serialized per organization. */
async function assertFormCapacity(tx: TenantTx, organizationId: string): Promise<void> {
  await lockForms(tx, organizationId);
  const [row] = await tx
    .select({ n: count() })
    .from(forms)
    .where(and(eq(forms.organizationId, organizationId), ne(forms.status, 'archived')));
  await assertWithinLimit(tx, organizationId, 'forms.max', (row?.n ?? 0) + 1);
}

export async function getFormRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
  options: { lock?: boolean } = {},
): Promise<Form> {
  const query = tx
    .select()
    .from(forms)
    .where(and(eq(forms.id, id), eq(forms.organizationId, organizationId)));
  const [form] = options.lock ? await query.for('update') : await query;
  if (!form) throw new NotFoundError('Form');
  return form;
}

async function versionsOf(
  tx: TenantTx,
  organizationId: string,
  formIds: readonly string[],
  statuses: FormVersion['status'][],
): Promise<FormVersion[]> {
  if (formIds.length === 0) return [];
  return tx
    .select()
    .from(formVersions)
    .where(
      and(
        eq(formVersions.organizationId, organizationId),
        inArray(formVersions.formId, [...formIds]),
        inArray(formVersions.status, statuses),
      ),
    );
}

async function fieldsOf(
  tx: TenantTx,
  organizationId: string,
  versionId: string,
): Promise<FormField[]> {
  return tx
    .select()
    .from(formFields)
    .where(and(eq(formFields.organizationId, organizationId), eq(formFields.versionId, versionId)))
    .orderBy(asc(formFields.position));
}

async function versionView(tx: TenantTx, version: FormVersion): Promise<FormVersionView> {
  return {
    id: version.id,
    number: version.number,
    status: version.status,
    settings: readSettings(version.settings),
    fields: (await fieldsOf(tx, version.organizationId, version.id)).map(toBuilderField),
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

async function summaries(
  tx: TenantTx,
  organizationId: string,
  rows: Form[],
): Promise<FormSummary[]> {
  const ids = rows.map((row) => row.id);
  const versions = await versionsOf(tx, organizationId, ids, ['draft', 'published']);
  const stats =
    ids.length === 0
      ? []
      : await tx
          .select({
            formId: formSubmissions.formId,
            n: count(),
            last: max(formSubmissions.submittedAt),
          })
          .from(formSubmissions)
          .where(and(inArray(formSubmissions.formId, ids), eq(formSubmissions.status, 'accepted')))
          .groupBy(formSubmissions.formId);
  return rows.map((form) => {
    const published = versions.find((v) => v.formId === form.id && v.status === 'published');
    const stat = stats.find((s) => s.formId === form.id);
    return {
      id: form.id,
      name: form.name,
      slug: form.slug,
      status: form.status,
      publishedVersion: published?.number ?? null,
      publishedAt: published?.publishedAt?.toISOString() ?? null,
      hasDraft: versions.some((v) => v.formId === form.id && v.status === 'draft'),
      submissionCount: stat?.n ?? 0,
      lastSubmissionAt: stat?.last?.toISOString() ?? null,
      createdAt: form.createdAt.toISOString(),
      updatedAt: form.updatedAt.toISOString(),
    };
  });
}

export async function listForms(
  tx: TenantTx,
  organizationId: string,
  rawQuery: z.input<typeof formListQuerySchema> = {},
): Promise<{ data: FormSummary[] }> {
  const query = formListQuerySchema.parse(rawQuery);
  const rows = await tx
    .select()
    .from(forms)
    .where(and(eq(forms.organizationId, organizationId), eq(forms.status, query.status)))
    .orderBy(desc(forms.createdAt), desc(forms.id))
    .limit(query.limit);
  return { data: await summaries(tx, organizationId, rows) };
}

export async function getForm(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<FormDetail> {
  const form = await getFormRow(tx, organizationId, id);
  const [summary] = await summaries(tx, organizationId, [form]);
  if (!summary) throw new NotFoundError('Form');
  const versions = await versionsOf(tx, organizationId, [form.id], ['draft', 'published']);
  const draft = versions.find((v) => v.status === 'draft');
  const published = versions.find((v) => v.status === 'published');
  return {
    ...summary,
    draft: draft ? await versionView(tx, draft) : null,
    published: published ? await versionView(tx, published) : null,
  };
}

async function insertFields(
  tx: TenantTx,
  organizationId: string,
  versionId: string,
  fields: z.infer<typeof fieldInputSchema>[],
): Promise<void> {
  if (fields.length === 0) return;
  await tx.insert(formFields).values(
    fields.map((field, position) => ({
      organizationId,
      versionId,
      key: field.key,
      type: field.type,
      label: field.label,
      required: field.required,
      position,
      placeholder: field.placeholder ?? null,
      helpText: field.helpText ?? null,
      options: field.options,
      validation: field.validation,
      defaultValue: field.type === 'hidden' ? (field.defaultValue ?? null) : null,
      target: field.target ?? null,
    })),
  );
}

/** Inserts with a unique slug; generated slugs get a random suffix, chosen ones must be free. */
async function insertForm(
  tx: TenantTx,
  ctx: CrmContext,
  name: string,
  slug: string | undefined,
): Promise<Form> {
  const candidates = slug
    ? [slug]
    : Array.from({ length: 3 }, () => `${slugify(name)}-${randomSuffix()}`);
  for (const candidate of candidates) {
    try {
      const [form] = await tx.transaction(async (sp) =>
        sp
          .insert(forms)
          .values({
            organizationId: ctx.organizationId,
            name,
            slug: candidate,
            createdByUserId: ctx.actor.userId,
          })
          .returning(),
      );
      if (form) return form;
    } catch (error) {
      if (!isUniqueViolation(error, 'forms_slug_unique')) throw error;
    }
  }
  throw new ConflictError('That link is already taken', {
    details: [{ path: 'slug', message: 'Choose another link' }],
  });
}

/** Creates a form with a draft holding the default fields. */
export async function createForm(
  tx: TenantTx,
  ctx: CrmContext,
  rawInput: CreateFormInput,
): Promise<FormDetail> {
  const input = createFormInputSchema.parse(rawInput);
  await assertFormCapacity(tx, ctx.organizationId);
  const form = await insertForm(tx, ctx, input.name, input.slug);
  const [version] = await tx
    .insert(formVersions)
    .values({
      organizationId: ctx.organizationId,
      formId: form.id,
      number: 1,
      status: 'draft',
      settings: formSettingsSchema.parse({}),
    })
    .returning();
  if (!version) throw new Error('form version insert returned no row');
  await insertFields(
    tx,
    ctx.organizationId,
    version.id,
    DEFAULT_FIELDS.map((field) => fieldInputSchema.parse(field)),
  );
  return getForm(tx, ctx.organizationId, form.id);
}

export async function updateForm(
  tx: TenantTx,
  ctx: CrmContext,
  id: string,
  rawInput: z.input<typeof updateFormInputSchema>,
): Promise<{ form: FormDetail; changedFields: string[] }> {
  const input = updateFormInputSchema.parse(rawInput);
  const current = await getFormRow(tx, ctx.organizationId, id, { lock: true });
  const set: Partial<typeof forms.$inferInsert> = {};
  if (input.name !== undefined && input.name !== current.name) set.name = input.name;
  if (input.slug !== undefined && input.slug !== current.slug) set.slug = input.slug;
  const changedFields = Object.keys(set);
  if (changedFields.length > 0) {
    try {
      await tx.transaction((sp) =>
        sp
          .update(forms)
          .set({ ...set, updatedAt: new Date() })
          .where(and(eq(forms.id, id), eq(forms.organizationId, ctx.organizationId))),
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'forms_slug_unique')) throw error;
      throw new ConflictError('That link is already taken', {
        details: [{ path: 'slug', message: 'Choose another link' }],
      });
    }
  }
  return { form: await getForm(tx, ctx.organizationId, id), changedFields };
}

/**
 * Settings that reference other records must point at live records of this organization:
 * a guessed or foreign id is rejected like any other invalid value.
 */
async function settingsProblems(
  tx: TenantTx,
  organizationId: string,
  settings: FormSettings,
): Promise<ErrorDetail[]> {
  const problems: ErrorDetail[] = [];
  const collect = async (path: string, check: () => Promise<unknown>) => {
    try {
      await check();
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      problems.push({ path, message: error.details?.[0]?.message ?? error.message });
    }
  };
  const { contact, deal } = settings;
  if (contact.ownerUserId) {
    const owner = contact.ownerUserId;
    await collect('settings.contact.ownerUserId', () =>
      assertActiveMember(tx, organizationId, owner, 'settings.contact.ownerUserId'),
    );
  }
  await collect('settings.contact.tagIds', () =>
    assertTagsExist(tx, organizationId, contact.tagIds, 'settings.contact.tagIds'),
  );
  if (deal) {
    if (!contact.enabled) {
      problems.push({ path: 'settings.deal', message: 'Deals need the contact step turned on' });
    }
    await collect('settings.deal', async () => {
      const stage = await resolveStage(
        tx,
        organizationId,
        deal.pipelineId,
        deal.stageId ?? undefined,
      );
      if (stage.kind !== 'open') {
        throw new ValidationError('Closed stage', [
          { path: 'settings.deal.stageId', message: 'Choose an open stage' },
        ]);
      }
    });
  }
  return problems;
}

async function assertValidVersion(
  tx: TenantTx,
  organizationId: string,
  fields: Parameters<typeof mappingProblems>[0],
  settings: FormSettings,
  captchaAvailable: boolean,
): Promise<void> {
  const customFields = await CustomFieldSet.load(tx, organizationId, 'contact');
  const problems = [
    ...mappingProblems(fields, customFields),
    ...(await settingsProblems(tx, organizationId, settings)),
  ];
  if (settings.captcha && !captchaAvailable) {
    problems.push({
      path: 'settings.captcha',
      message: 'No captcha provider is configured (CONFIGURATION_REQUIRED)',
    });
  }
  if (problems.length > 0) throw new ValidationError('Please fix the form', problems);
}

async function draftOf(
  tx: TenantTx,
  organizationId: string,
  formId: string,
): Promise<FormVersion | undefined> {
  const [draft] = await versionsOf(tx, organizationId, [formId], ['draft']);
  return draft;
}

/**
 * Replaces the draft's fields and settings (creating the next draft version when the form has
 * only a published one). Published versions never change.
 */
export async function saveDraft(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  rawInput: SaveDraftInput,
  options: { captchaAvailable: boolean },
): Promise<FormDetail> {
  const input = saveDraftInputSchema.parse(rawInput);
  const form = await getFormRow(tx, ctx.organizationId, formId, { lock: true });
  if (form.status === 'archived') throw new ConflictError('Restore the form before editing it');
  await assertValidVersion(
    tx,
    ctx.organizationId,
    input.fields,
    input.settings,
    options.captchaAvailable,
  );
  let draft = await draftOf(tx, ctx.organizationId, formId);
  if (draft) {
    await tx
      .update(formVersions)
      .set({ settings: input.settings, updatedAt: new Date() })
      .where(
        and(eq(formVersions.id, draft.id), eq(formVersions.organizationId, ctx.organizationId)),
      );
    await tx
      .delete(formFields)
      .where(
        and(eq(formFields.versionId, draft.id), eq(formFields.organizationId, ctx.organizationId)),
      );
  } else {
    const [latest] = await tx
      .select({ n: max(formVersions.number) })
      .from(formVersions)
      .where(
        and(eq(formVersions.formId, formId), eq(formVersions.organizationId, ctx.organizationId)),
      );
    [draft] = await tx
      .insert(formVersions)
      .values({
        organizationId: ctx.organizationId,
        formId,
        number: (latest?.n ?? 0) + 1,
        status: 'draft',
        settings: input.settings,
      })
      .returning();
    if (!draft) throw new Error('form version insert returned no row');
  }
  await insertFields(tx, ctx.organizationId, draft.id, input.fields);
  await tx
    .update(forms)
    .set({ updatedAt: new Date() })
    .where(and(eq(forms.id, formId), eq(forms.organizationId, ctx.organizationId)));
  return getForm(tx, ctx.organizationId, formId);
}

/** Drops unpublished changes (only when a published version remains). */
export async function discardDraft(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
): Promise<FormDetail> {
  await getFormRow(tx, ctx.organizationId, formId, { lock: true });
  const versions = await versionsOf(tx, ctx.organizationId, [formId], ['draft', 'published']);
  const draft = versions.find((v) => v.status === 'draft');
  if (!draft) throw new ConflictError('There are no unpublished changes');
  if (!versions.some((v) => v.status === 'published')) {
    throw new ConflictError('A form that was never published has nothing to go back to');
  }
  await tx
    .delete(formVersions)
    .where(and(eq(formVersions.id, draft.id), eq(formVersions.organizationId, ctx.organizationId)));
  return getForm(tx, ctx.organizationId, formId);
}

/**
 * Publishes the draft: the current published version is retired (its submissions keep pointing
 * at it) and the draft becomes the live version. Everything is re-validated, since custom
 * fields, tags, members or pipelines may have changed since the draft was saved.
 */
export async function publishForm(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  options: { captchaAvailable: boolean },
): Promise<FormDetail> {
  const form = await getFormRow(tx, ctx.organizationId, formId, { lock: true });
  if (form.status === 'archived') throw new ConflictError('Restore the form before publishing it');
  const draft = await draftOf(tx, ctx.organizationId, formId);
  if (!draft) throw new ConflictError('There are no unpublished changes');
  const fields = await fieldsOf(tx, ctx.organizationId, draft.id);
  const settings = readSettings(draft.settings);
  await assertValidVersion(tx, ctx.organizationId, fields, settings, options.captchaAvailable);
  const now = new Date();
  await tx
    .update(formVersions)
    .set({ status: 'retired', updatedAt: now })
    .where(
      and(
        eq(formVersions.formId, formId),
        eq(formVersions.organizationId, ctx.organizationId),
        eq(formVersions.status, 'published'),
      ),
    );
  await tx
    .update(formVersions)
    .set({
      status: 'published',
      publishedAt: now,
      publishedByUserId: ctx.actor.userId,
      updatedAt: now,
    })
    .where(and(eq(formVersions.id, draft.id), eq(formVersions.organizationId, ctx.organizationId)));
  await tx
    .update(forms)
    .set({ updatedAt: now })
    .where(and(eq(forms.id, formId), eq(forms.organizationId, ctx.organizationId)));
  return getForm(tx, ctx.organizationId, formId);
}

/** Archived forms stop accepting submissions and free a `forms.max` slot. */
export async function setFormArchived(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  archived: boolean,
): Promise<FormDetail> {
  const form = await getFormRow(tx, ctx.organizationId, formId, { lock: true });
  const status = archived ? 'archived' : 'active';
  if (form.status === status) {
    throw new ConflictError(archived ? 'The form is already archived' : 'The form is not archived');
  }
  if (!archived) await assertFormCapacity(tx, ctx.organizationId);
  await tx
    .update(forms)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(forms.id, formId), eq(forms.organizationId, ctx.organizationId)));
  return getForm(tx, ctx.organizationId, formId);
}

export interface PublicForm {
  organizationId: string;
  organization: {
    name: string;
    countryCode: string;
    defaultCurrency: string;
    timezone: string;
  };
  form: { id: string; slug: string; name: string };
  versionId: string;
  settings: FormSettings;
  fields: PublicField[];
}

/**
 * Resolves a public form link to its live version. The slug is looked up in system scope
 * because the visitor is anonymous and the tenant is not known yet; everything else is read in
 * that tenant's scope. Archived, unpublished and deleted-organization forms are not found.
 */
export async function resolvePublicForm(db: Database, slug: string): Promise<PublicForm | null> {
  if (!formSlugSchema.safeParse(slug).success) return null;
  // System scope: the anonymous visitor's slug is what identifies the tenant.
  const [found] = await withSystem(db, (tx) =>
    tx
      .select({ id: forms.id, organizationId: forms.organizationId })
      .from(forms)
      .where(and(eq(forms.slug, slug), eq(forms.status, 'active'))),
  );
  if (!found) return null;
  return withTenant(db, { organizationId: found.organizationId, userId: null }, async (tx) => {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, found.organizationId));
    if (!organization || organization.deletedAt) return null;
    const form = await getFormRow(tx, found.organizationId, found.id);
    const [published] = await versionsOf(tx, found.organizationId, [form.id], ['published']);
    if (!published) return null;
    const fields = await fieldsOf(tx, found.organizationId, published.id);
    return {
      organizationId: found.organizationId,
      organization: {
        name: organization.name,
        countryCode: organization.countryCode,
        defaultCurrency: organization.defaultCurrency,
        timezone: organization.timezone,
      },
      form: { id: form.id, slug: form.slug, name: form.name },
      versionId: published.id,
      settings: readSettings(published.settings),
      fields: fields.map(toPublicField),
    };
  });
}

/** A version (published or retired) with its fields, for accepting a submission. */
export async function loadSubmittableVersion(
  tx: TenantTx,
  organizationId: string,
  formId: string,
  versionId: string,
): Promise<{ form: Form; version: FormVersion; fields: FormField[] }> {
  const form = await getFormRow(tx, organizationId, formId);
  if (form.status !== 'active') throw new NotFoundError('Form');
  const [version] = await tx
    .select()
    .from(formVersions)
    .where(
      and(
        eq(formVersions.id, versionId),
        eq(formVersions.formId, formId),
        eq(formVersions.organizationId, organizationId),
        inArray(formVersions.status, ['published', 'retired']),
      ),
    );
  if (!version) throw new NotFoundError('Form');
  return { form, version, fields: await fieldsOf(tx, organizationId, version.id) };
}
