import {
  createContact,
  createDeal,
  createNote,
  CustomFieldSet,
  displayName,
  eventMeta,
  findContactByEmail,
  updateContact,
  addTags,
  type CrmContext,
  type UpdateContactInput,
} from '@businessos/crm';
import {
  crmContacts,
  crmTags,
  formFields,
  formSubmissions,
  formVersions,
  memberships,
  organizations,
  withTenant,
  type CrmContact,
  type Database,
  type Form,
  type FormField,
  type FormSubmission,
  type Organization,
  type SubmissionStatus,
  type TenantTx,
} from '@businessos/database';
import { emitEvent } from '@businessos/events';
import {
  ConflictError,
  decodeCursor,
  EntitlementExceededError,
  encodeCursor,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { validateAnswers } from './fields';
import { getFormRow, loadSubmittableVersion } from './forms';
import { hasIdentity, mapAnswers, type MappedContact } from './mapping';
import { readSettings, type FormSettings } from './settings';
import { spamReasons, type SubmissionSignals } from './spam';

export interface SubmitFormInput {
  organizationId: string;
  formId: string;
  versionId: string;
  answers: unknown;
  /** Derived from the render token: one submission per rendered form. */
  idempotencyKey: string;
  signals: SubmissionSignals;
  userAgent: string | null;
  correlationId: string | null;
}

export interface SubmitFormResult {
  submissionId: string;
  status: SubmissionStatus;
  /** The same rendered form was already submitted (double click, retry). */
  duplicate: boolean;
}

/** CRM context of an anonymous submitter: a system actor in the form's organization. */
export function submitterContext(
  organization: Organization,
  correlationId: string | null,
): CrmContext {
  return {
    organizationId: organization.id,
    countryCode: organization.countryCode,
    defaultCurrency: organization.defaultCurrency,
    timezone: organization.timezone,
    actor: { type: 'system', userId: null, correlationId },
  };
}

async function findByKey(
  tx: TenantTx,
  formId: string,
  idempotencyKey: string,
): Promise<FormSubmission | undefined> {
  const [row] = await tx
    .select()
    .from(formSubmissions)
    .where(
      and(eq(formSubmissions.formId, formId), eq(formSubmissions.idempotencyKey, idempotencyKey)),
    );
  return row;
}

/**
 * Accepts a public submission: answers are validated against the version the visitor saw,
 * spam is stored but quarantined, and genuine submissions update the CRM as the form's
 * settings say. Everything happens in one tenant transaction together with `form.submitted`.
 */
export async function submitForm(db: Database, input: SubmitFormInput): Promise<SubmitFormResult> {
  return withTenant(db, { organizationId: input.organizationId, userId: null }, async (tx) => {
    const { form, version, fields } = await loadSubmittableVersion(
      tx,
      input.organizationId,
      input.formId,
      input.versionId,
    );
    const previous = await findByKey(tx, form.id, input.idempotencyKey);
    if (previous) return { submissionId: previous.id, status: previous.status, duplicate: true };
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, input.organizationId));
    if (!organization || organization.deletedAt) throw new NotFoundError('Form');

    const answers = validateAnswers(fields, input.answers, organization.countryCode);
    const reasons = spamReasons(input.signals, fields, answers);
    const status: SubmissionStatus = reasons.length > 0 ? 'spam' : 'accepted';
    const [row] = await tx
      .insert(formSubmissions)
      .values({
        organizationId: input.organizationId,
        formId: form.id,
        versionId: version.id,
        answers,
        status,
        spamReasons: reasons,
        idempotencyKey: input.idempotencyKey,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      })
      .onConflictDoNothing({ target: [formSubmissions.formId, formSubmissions.idempotencyKey] })
      .returning();
    if (!row) {
      // A concurrent request with the same render token won the race.
      const winner = await findByKey(tx, form.id, input.idempotencyKey);
      if (!winner) throw new ConflictError('Please submit the form again');
      return { submissionId: winner.id, status: winner.status, duplicate: true };
    }
    if (status === 'spam') return { submissionId: row.id, status, duplicate: false };

    const ctx = submitterContext(organization, input.correlationId);
    const outcome = await processSubmission(tx, ctx, {
      form,
      settings: readSettings(version.settings),
      fields,
      answers,
    });
    await tx
      .update(formSubmissions)
      .set({
        contactId: outcome.contactId,
        dealId: outcome.dealId,
        processingNotes: outcome.notes,
      })
      .where(
        and(
          eq(formSubmissions.id, row.id),
          eq(formSubmissions.organizationId, input.organizationId),
        ),
      );
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'form.submitted',
      subject: { type: 'form_submission', id: row.id },
      payload: {
        formId: form.id,
        versionId: version.id,
        submissionId: row.id,
        contactId: outcome.contactId,
        dealId: outcome.dealId,
      },
    });
    return { submissionId: row.id, status, duplicate: false };
  });
}

interface ProcessInput {
  form: Form;
  settings: FormSettings;
  fields: FormField[];
  answers: Record<string, unknown>;
}

interface ProcessOutcome {
  contactId: string | null;
  dealId: string | null;
  notes: string[];
}

function errorText(
  error: ValidationError | ConflictError | NotFoundError | EntitlementExceededError,
) {
  const detail = error instanceof ValidationError ? error.details?.[0]?.message : undefined;
  return detail ? `${error.message} (${detail})` : error.message;
}

/**
 * Runs a CRM step in a savepoint. A step that cannot be done (a deleted tag, a full contact
 * quota, a custom field that changed type) is recorded as a note on the submission instead of
 * losing the submission; unexpected errors still fail the whole request.
 */
async function step<T>(
  tx: TenantTx,
  notes: string[],
  describe: (message: string) => string,
  fn: (sp: TenantTx) => Promise<T>,
): Promise<T | null> {
  try {
    return await tx.transaction((sp) => fn(sp as TenantTx));
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ConflictError ||
      error instanceof NotFoundError ||
      error instanceof EntitlementExceededError
    ) {
      notes.push(describe(errorText(error)));
      return null;
    }
    throw error;
  }
}

async function processSubmission(
  tx: TenantTx,
  ctx: CrmContext,
  input: ProcessInput,
): Promise<ProcessOutcome> {
  const notes: string[] = [];
  const { settings } = input;
  if (!settings.contact.enabled) return { contactId: null, dealId: null, notes };
  const mapped = mapAnswers(input.fields, input.answers);
  if (!hasIdentity(mapped)) {
    notes.push('No contact details were mapped, so no contact was created');
    return { contactId: null, dealId: null, notes };
  }
  const ownerUserId = await liveOwner(tx, ctx.organizationId, settings.contact.ownerUserId, notes);
  const contactId = await upsertContact(tx, ctx, mapped, settings, ownerUserId, notes);
  if (!contactId) return { contactId: null, dealId: null, notes };

  await applyTags(tx, ctx, contactId, settings.contact.tagIds, notes);
  let dealId: string | null = null;
  if (settings.deal) {
    const deal = settings.deal;
    const contact = await contactRow(tx, ctx.organizationId, contactId);
    const name = `${input.form.name}: ${contact ? displayName(contact) : 'new submission'}`;
    const created = await step(
      tx,
      notes,
      (message) => `Deal not created: ${message}`,
      (sp) =>
        createDeal(sp, ctx, {
          name: name.slice(0, 200),
          pipelineId: deal.pipelineId,
          ...(deal.stageId ? { stageId: deal.stageId } : {}),
          contactId,
          ownerUserId,
        }),
    );
    dealId = created?.id ?? null;
  }
  if (settings.contact.addNote) {
    await step(
      tx,
      notes,
      (message) => `Note not added: ${message}`,
      (sp) =>
        createNote(
          sp,
          ctx,
          { type: 'contact', id: contactId },
          {
            body: answersAsText(input.form.name, input.fields, input.answers),
          },
        ),
    );
  }
  return { contactId, dealId, notes };
}

/** The configured owner if still an active member (otherwise unassigned, with a note). */
async function liveOwner(
  tx: TenantTx,
  organizationId: string,
  ownerUserId: string | null,
  notes: string[],
): Promise<string | null> {
  if (!ownerUserId) return null;
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, ownerUserId),
        eq(memberships.status, 'active'),
      ),
    );
  if (row) return ownerUserId;
  notes.push('The configured owner is no longer a member; records were left unassigned');
  return null;
}

async function contactRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<CrmContact | undefined> {
  const [row] = await tx
    .select()
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.id, id),
        eq(crmContacts.organizationId, organizationId),
        isNull(crmContacts.deletedAt),
      ),
    );
  return row;
}

async function findExistingContact(
  tx: TenantTx,
  organizationId: string,
  mapped: MappedContact,
): Promise<string | null> {
  if (mapped.email) return findContactByEmail(tx, organizationId, mapped.email);
  const phone = mapped.phone ?? mapped.whatsappPhone;
  if (!phone) return null;
  const [row] = await tx
    .select({ id: crmContacts.id })
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.organizationId, organizationId),
        isNull(crmContacts.deletedAt),
        sql`(${crmContacts.phone} = ${phone} or ${crmContacts.whatsappPhone} = ${phone})`,
      ),
    )
    .orderBy(asc(crmContacts.createdAt), asc(crmContacts.id))
    .limit(1);
  return row?.id ?? null;
}

const STANDARD_KEYS = ['email', 'phone', 'whatsappPhone', 'jobTitle'] as const;

/**
 * Finds the submitter's contact (email first, then phone) or creates one. Existing contacts are
 * only completed — empty properties are filled, nothing the team entered is overwritten — so a
 * stranger who knows a customer's email cannot change that customer's record.
 */
async function upsertContact(
  tx: TenantTx,
  ctx: CrmContext,
  mapped: MappedContact,
  settings: FormSettings,
  ownerUserId: string | null,
  notes: string[],
): Promise<string | null> {
  const existingId = await findExistingContact(tx, ctx.organizationId, mapped);
  if (existingId) {
    await fillEmpty(tx, ctx, existingId, mapped, notes);
    return existingId;
  }
  const base = {
    firstName: mapped.firstName ?? null,
    lastName: mapped.lastName ?? null,
    email: mapped.email ?? null,
    phone: mapped.phone ?? null,
    whatsappPhone: mapped.whatsappPhone ?? null,
    jobTitle: mapped.jobTitle ?? null,
    ownerUserId,
    source: 'form',
    ...(settings.contact.lifecycleStage ? { lifecycleStage: settings.contact.lifecycleStage } : {}),
  };
  const hasCustom = Object.keys(mapped.customFields).length > 0;
  const attempts = hasCustom ? [{ ...base, customFields: mapped.customFields }, base] : [base];
  for (const [index, attempt] of attempts.entries()) {
    try {
      const created = await tx.transaction((sp) => createContact(sp as TenantTx, ctx, attempt));
      return created.id;
    } catch (error) {
      if (error instanceof EntitlementExceededError) {
        notes.push("Contact not created: the plan's contact limit is reached");
        return null;
      }
      if (error instanceof ConflictError) {
        // Someone created the same email meanwhile: complete that contact instead.
        const raced = await findExistingContact(tx, ctx.organizationId, mapped);
        if (!raced) throw error;
        await fillEmpty(tx, ctx, raced, mapped, notes);
        return raced;
      }
      if (!(error instanceof ValidationError)) throw error;
      const last = index === attempts.length - 1;
      notes.push(
        `${last ? 'Contact not created' : 'Custom fields not saved'}: ${errorText(error)}`,
      );
      if (last) return null;
    }
  }
  return null;
}

async function fillEmpty(
  tx: TenantTx,
  ctx: CrmContext,
  contactId: string,
  mapped: MappedContact,
  notes: string[],
): Promise<void> {
  const current = await contactRow(tx, ctx.organizationId, contactId);
  if (!current) return;
  const patch: UpdateContactInput = {};
  // Names are completed together so two different people's names are never mixed.
  if (current.firstName === null && current.lastName === null) {
    if (mapped.firstName) patch.firstName = mapped.firstName;
    if (mapped.lastName) patch.lastName = mapped.lastName;
  }
  for (const key of STANDARD_KEYS) {
    const value = mapped[key];
    if (value !== undefined && current[key] === null) patch[key] = value;
  }
  const custom: Record<string, unknown> = {};
  if (Object.keys(mapped.customFields).length > 0) {
    const set = await CustomFieldSet.load(tx, ctx.organizationId, 'contact');
    const present = set.toApi(current.customFields);
    for (const [key, value] of Object.entries(mapped.customFields)) {
      if (!Object.hasOwn(present, key)) custom[key] = value;
    }
  }
  const attempts: UpdateContactInput[] = [];
  if (Object.keys(custom).length > 0) attempts.push({ ...patch, customFields: custom });
  if (Object.keys(patch).length > 0) attempts.push(patch);
  for (const [index, attempt] of attempts.entries()) {
    const last = index === attempts.length - 1;
    const done = await step(
      tx,
      notes,
      (message) =>
        last ? `Contact details not updated: ${message}` : `Custom fields not saved: ${message}`,
      (sp) => updateContact(sp, ctx, contactId, attempt),
    );
    if (done) return;
  }
}

/** Applies the form's tags; tags deleted since publishing are skipped with a note. */
async function applyTags(
  tx: TenantTx,
  ctx: CrmContext,
  contactId: string,
  tagIds: readonly string[],
  notes: string[],
): Promise<void> {
  if (tagIds.length === 0) return;
  const live = await tx
    .select({ id: crmTags.id })
    .from(crmTags)
    .where(and(eq(crmTags.organizationId, ctx.organizationId), inArray(crmTags.id, [...tagIds])));
  if (live.length < tagIds.length) notes.push('Some tags no longer exist and were skipped');
  if (live.length === 0) return;
  const added = await addTags(
    tx,
    ctx.organizationId,
    'contact',
    [contactId],
    live.map((tag) => tag.id),
  );
  for (const pair of added) {
    await emitEvent(tx, {
      ...eventMeta(ctx),
      type: 'contact.tag_added',
      subject: { type: 'contact', id: contactId },
      payload: { contactId, tagId: pair.tagId },
    });
  }
}

/** Human-readable answer: choice values are shown with their option labels. */
function formatAnswer(field: FormField, value: unknown): string {
  const label = (item: unknown) =>
    field.options.find((option) => option.value === item)?.label ?? String(item);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (value === true) return 'Yes';
  if (field.options.length > 0) return label(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Plain-text rendering of the answers (notes, exports). */
export function answersAsText(
  formName: string,
  fields: readonly FormField[],
  answers: Record<string, unknown>,
): string {
  const lines = fields
    .filter((field) => Object.hasOwn(answers, field.key))
    .map((field) => `${field.label}: ${formatAnswer(field, answers[field.key])}`);
  return [`Form: ${formName}`, '', ...lines].join('\n').slice(0, 20_000);
}

// ── Staff views ─────────────────────────────────────────────────────────────────────────

export const submissionListQuerySchema = z.object({
  status: z.enum(['accepted', 'spam']).default('accepted'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface SubmissionSummary {
  id: string;
  formId: string;
  versionNumber: number;
  status: SubmissionStatus;
  submittedAt: string;
  /** First few answers for the list view. */
  preview: { label: string; value: string }[];
  contact: { id: string; name: string } | null;
  dealId: string | null;
}

export interface SubmissionDetail extends SubmissionSummary {
  answers: { key: string; label: string; type: FormField['type']; value: string }[];
  spamReasons: string[];
  processingNotes: string[];
  userAgent: string | null;
}

const cursorSchema = z.object({ v: z.string().max(40), id: z.uuid() });

async function labelsFor(
  tx: TenantTx,
  organizationId: string,
  versionIds: readonly string[],
): Promise<Map<string, FormField[]>> {
  const map = new Map<string, FormField[]>();
  if (versionIds.length === 0) return map;
  const rows = await tx
    .select()
    .from(formFields)
    .where(
      and(
        eq(formFields.organizationId, organizationId),
        inArray(formFields.versionId, [...versionIds]),
      ),
    )
    .orderBy(asc(formFields.position));
  for (const row of rows) map.set(row.versionId, [...(map.get(row.versionId) ?? []), row]);
  return map;
}

async function toSummaries(
  tx: TenantTx,
  ctx: CrmContext,
  rows: FormSubmission[],
): Promise<{ summaries: SubmissionSummary[]; fields: Map<string, FormField[]> }> {
  const versionIds = [...new Set(rows.map((row) => row.versionId))];
  const fields = await labelsFor(tx, ctx.organizationId, versionIds);
  const numbers =
    versionIds.length === 0
      ? []
      : await tx
          .select({ id: formVersions.id, number: formVersions.number })
          .from(formVersions)
          .where(
            and(
              eq(formVersions.organizationId, ctx.organizationId),
              inArray(formVersions.id, versionIds),
            ),
          );
  const canSeeContacts = ctx.canRead?.contact ?? true;
  const contactIds = [
    ...new Set(rows.map((row) => row.contactId).filter((id): id is string => id !== null)),
  ];
  const contacts =
    canSeeContacts && contactIds.length > 0
      ? await tx
          .select()
          .from(crmContacts)
          .where(
            and(
              eq(crmContacts.organizationId, ctx.organizationId),
              inArray(crmContacts.id, contactIds),
              isNull(crmContacts.deletedAt),
            ),
          )
      : [];
  const summaries = rows.map((row) => {
    const versionFields = fields.get(row.versionId) ?? [];
    const contact = contacts.find((c) => c.id === row.contactId);
    return {
      id: row.id,
      formId: row.formId,
      versionNumber: numbers.find((n) => n.id === row.versionId)?.number ?? 0,
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      preview: versionFields
        .filter((field) => field.type !== 'hidden' && Object.hasOwn(row.answers, field.key))
        .slice(0, 3)
        .map((field) => ({
          label: field.label,
          value: formatAnswer(field, row.answers[field.key]).slice(0, 200),
        })),
      contact: contact ? { id: contact.id, name: displayName(contact) } : null,
      dealId: (ctx.canRead?.deal ?? true) ? row.dealId : null,
    };
  });
  return { summaries, fields };
}

export async function listSubmissions(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  rawQuery: z.input<typeof submissionListQuerySchema>,
): Promise<{ data: SubmissionSummary[]; nextCursor: string | null }> {
  const query = submissionListQuerySchema.parse(rawQuery);
  await getFormRow(tx, ctx.organizationId, formId);
  const conditions: SQL[] = [
    eq(formSubmissions.organizationId, ctx.organizationId),
    eq(formSubmissions.formId, formId),
    eq(formSubmissions.status, query.status),
  ];
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    conditions.push(
      sql`(${formSubmissions.submittedAt}, ${formSubmissions.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({
      row: formSubmissions,
      sortValue: sql<string>`${formSubmissions.submittedAt}::text`,
    })
    .from(formSubmissions)
    .where(and(...conditions))
    .orderBy(desc(formSubmissions.submittedAt), desc(formSubmissions.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const { summaries } = await toSummaries(
    tx,
    ctx,
    page.map((entry) => entry.row),
  );
  return {
    data: summaries,
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: last.sortValue, id: last.row.id })
        : null,
  };
}

export async function getSubmission(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  id: string,
): Promise<SubmissionDetail> {
  const [row] = await tx
    .select()
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.id, id),
        eq(formSubmissions.formId, formId),
        eq(formSubmissions.organizationId, ctx.organizationId),
      ),
    );
  if (!row) throw new NotFoundError('Submission');
  const { summaries, fields } = await toSummaries(tx, ctx, [row]);
  const summary = summaries[0];
  if (!summary) throw new NotFoundError('Submission');
  return {
    ...summary,
    answers: (fields.get(row.versionId) ?? [])
      .filter((field) => Object.hasOwn(row.answers, field.key))
      .map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        value: formatAnswer(field, row.answers[field.key]),
      })),
    spamReasons: row.spamReasons,
    processingNotes: row.processingNotes,
    userAgent: row.userAgent,
  };
}

/**
 * Releases a quarantined submission that a person judged genuine: it is processed into the CRM
 * exactly like a fresh submission (by the releasing member) and `form.submitted` is emitted.
 */
export async function releaseSubmission(
  tx: TenantTx,
  ctx: CrmContext,
  formId: string,
  id: string,
): Promise<SubmissionDetail> {
  const form = await getFormRow(tx, ctx.organizationId, formId);
  const [row] = await tx
    .select()
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.id, id),
        eq(formSubmissions.formId, formId),
        eq(formSubmissions.organizationId, ctx.organizationId),
      ),
    )
    .for('update');
  if (!row) throw new NotFoundError('Submission');
  if (row.status !== 'spam')
    throw new ConflictError('Only submissions marked as spam can be released');
  const [version] = await tx
    .select()
    .from(formVersions)
    .where(
      and(eq(formVersions.id, row.versionId), eq(formVersions.organizationId, ctx.organizationId)),
    );
  if (!version) throw new NotFoundError('Submission');
  const fields = await tx
    .select()
    .from(formFields)
    .where(
      and(eq(formFields.versionId, version.id), eq(formFields.organizationId, ctx.organizationId)),
    )
    .orderBy(asc(formFields.position));
  const outcome = await processSubmission(tx, ctx, {
    form,
    settings: readSettings(version.settings),
    fields,
    answers: row.answers,
  });
  await tx
    .update(formSubmissions)
    .set({
      status: 'accepted',
      contactId: outcome.contactId,
      dealId: outcome.dealId,
      processingNotes: outcome.notes,
    })
    .where(
      and(eq(formSubmissions.id, row.id), eq(formSubmissions.organizationId, ctx.organizationId)),
    );
  await emitEvent(tx, {
    ...eventMeta(ctx),
    type: 'form.submitted',
    subject: { type: 'form_submission', id: row.id },
    payload: {
      formId,
      versionId: version.id,
      submissionId: row.id,
      contactId: outcome.contactId,
      dealId: outcome.dealId,
    },
  });
  return getSubmission(tx, ctx, formId, id);
}
