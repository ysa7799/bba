import {
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  startSubscription,
} from '@businessos/billing';
import {
  createContact,
  createCustomField,
  createTag,
  defaultPipeline,
  deleteTag,
  getContact,
  type CrmContext,
} from '@businessos/crm';
import {
  activities,
  crmContacts,
  crmDeals,
  crmNotes,
  formSubmissions,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { createOrganization } from '@businessos/organizations';
import {
  ConflictError,
  EntitlementExceededError,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import {
  createTestDatabase,
  createTestUser,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { projectEvent } from '@businessos/activities';
import { loadEvent } from '@businessos/events';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  createForm,
  discardDraft,
  formsTimelineProjectors,
  getForm,
  getSubmission,
  listForms,
  listSubmissions,
  publishForm,
  releaseSubmission,
  resolvePublicForm,
  saveDraft,
  setFormArchived,
  submitForm,
  updateForm,
  type FormDetail,
  type SaveDraftInput,
  type SubmitFormInput,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase(8);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;
const aOwner = () => world.orgA.users.owner.id;
const captcha = { captchaAvailable: false };

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: userId ? 'user' : 'system', userId },
  };
}

function inOrg<T>(
  org: Organization,
  userId: string | null,
  fn: (tx: TenantTx, ctx: CrmContext) => Promise<T>,
) {
  return withTenant(handle.db, { organizationId: org.id, userId }, (tx) =>
    fn(tx, ctxFor(org, userId)),
  );
}

async function rejects<E>(promise: Promise<unknown>, type: abstract new (...args: never[]) => E) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

/** A published form in org A with the given draft. */
async function publishedForm(draft?: SaveDraftInput, org: Organization = A()): Promise<FormDetail> {
  const owner = org.id === A().id ? aOwner() : world.orgB.users.owner.id;
  return inOrg(org, owner, async (tx, ctx) => {
    const form = await createForm(tx, ctx, { name: `Contact us ${uniqueSuffix()}` });
    if (draft) await saveDraft(tx, ctx, form.id, draft, captcha);
    return publishForm(tx, ctx, form.id, captcha);
  });
}

let keyCounter = 0;
function submission(form: FormDetail, answers: unknown, overrides: Partial<SubmitFormInput> = {}) {
  const versionId = form.published?.id ?? '';
  return {
    organizationId: A().id,
    formId: form.id,
    versionId,
    answers,
    idempotencyKey: `key-${uniqueSuffix()}-${keyCounter++}`,
    signals: { elapsedMs: 10_000 },
    userAgent: 'vitest',
    correlationId: null,
    ...overrides,
  } satisfies SubmitFormInput;
}

function contactByEmail(org: Organization, email: string) {
  return inOrg(org, null, async (tx) => {
    const [row] = await tx
      .select()
      .from(crmContacts)
      .where(and(eq(crmContacts.organizationId, org.id), eq(crmContacts.email, email)));
    return row;
  });
}

describe('building and publishing', () => {
  it('creates a draft with default fields, publishes it and versions later edits', async () => {
    const created = await inOrg(A(), aOwner(), (tx, ctx) =>
      createForm(tx, ctx, { name: 'Website enquiry' }),
    );
    expect(created.slug).toMatch(/^website-enquiry-[a-z0-9]{6}$/);
    expect(created.published).toBeNull();
    expect(created.draft?.fields.map((f) => [f.key, f.target])).toEqual([
      ['full_name', 'contact.fullName'],
      ['email', 'contact.email'],
      ['phone', 'contact.phone'],
      ['message', null],
    ]);
    expect(await resolvePublicForm(handle.db, created.slug)).toBeNull();

    const published = await inOrg(A(), aOwner(), (tx, ctx) =>
      publishForm(tx, ctx, created.id, captcha),
    );
    expect(published).toMatchObject({ publishedVersion: 1, hasDraft: false, draft: null });
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => publishForm(tx, ctx, created.id, captcha)),
      ConflictError,
    );

    // Editing creates version 2 as a draft; the live form stays on version 1.
    const edited = await inOrg(A(), aOwner(), (tx, ctx) =>
      saveDraft(
        tx,
        ctx,
        created.id,
        {
          fields: [
            {
              key: 'email',
              type: 'email',
              label: 'Work email',
              required: true,
              target: 'contact.email',
            },
          ],
          settings: { successMessage: 'Thanks!' },
        },
        captcha,
      ),
    );
    expect(edited.draft?.number).toBe(2);
    expect((await resolvePublicForm(handle.db, created.slug))?.fields).toHaveLength(4);
    const discarded = await inOrg(A(), aOwner(), (tx, ctx) => discardDraft(tx, ctx, created.id));
    expect(discarded.draft).toBeNull();

    await inOrg(A(), aOwner(), (tx, ctx) =>
      saveDraft(
        tx,
        ctx,
        created.id,
        { fields: [{ key: 'email', type: 'email', label: 'Work email', target: 'contact.email' }] },
        captcha,
      ),
    );
    const republished = await inOrg(A(), aOwner(), (tx, ctx) =>
      publishForm(tx, ctx, created.id, captcha),
    );
    // The discarded draft's number is reused: numbers stay contiguous among kept versions.
    expect(republished.publishedVersion).toBe(2);
    const live = await resolvePublicForm(handle.db, created.slug);
    expect(live?.fields.map((f) => f.label)).toEqual(['Work email']);
    expect(live?.fields[0]).not.toHaveProperty('target');
  });

  it('validates drafts: unique keys, the mapping allow-list and referenced records', async () => {
    const form = await inOrg(A(), aOwner(), (tx, ctx) => createForm(tx, ctx, { name: 'Checks' }));
    const save = (draft: SaveDraftInput) =>
      inOrg(A(), aOwner(), (tx, ctx) => saveDraft(tx, ctx, form.id, draft, captcha));

    await rejects(
      save({
        fields: [
          { key: 'a', type: 'text', label: 'A' },
          { key: 'a', type: 'text', label: 'Again' },
        ],
      }),
      ZodError,
    );
    await rejects(save({ fields: [{ key: 'h', type: 'hidden', label: 'H' }] }), ZodError);
    const protectedTarget = await rejects(
      save({
        fields: [{ key: 'owner', type: 'text', label: 'Owner', target: 'contact.ownerUserId' }],
      }),
      ValidationError,
    );
    expect(protectedTarget.details?.[0]?.path).toBe('fields.0.target');

    // Records of another tenant (or guessed ids) are refused.
    const bTag = await inOrg(B(), null, (tx) =>
      createTag(tx, B().id, { name: `B ${uniqueSuffix()}` }),
    );
    const bPipeline = await inOrg(B(), null, (tx) => defaultPipeline(tx, B().id));
    const foreign = await rejects(
      save({
        fields: [{ key: 'email', type: 'email', label: 'Email', target: 'contact.email' }],
        settings: {
          contact: { ownerUserId: world.orgB.users.owner.id, tagIds: [bTag.id] },
          deal: { pipelineId: bPipeline.id },
        },
      }),
      ValidationError,
    );
    expect(foreign.details?.map((d) => d.path).sort()).toEqual([
      'settings.contact.ownerUserId',
      'settings.contact.tagIds',
      'settings.deal',
    ]);
    const noCaptcha = await rejects(
      save({
        fields: [{ key: 'email', type: 'email', label: 'Email' }],
        settings: { captcha: true },
      }),
      ValidationError,
    );
    expect(noCaptcha.details?.[0]?.path).toBe('settings.captcha');
  });

  it('keeps slugs globally unique and lets archived forms go offline', async () => {
    const slug = `unique-${uniqueSuffix()}`.toLowerCase();
    const form = await inOrg(A(), aOwner(), (tx, ctx) =>
      createForm(tx, ctx, { name: 'One', slug }),
    );
    await rejects(
      inOrg(B(), world.orgB.users.owner.id, (tx, ctx) =>
        createForm(tx, ctx, { name: 'Two', slug }),
      ),
      ConflictError,
    );
    await inOrg(A(), aOwner(), (tx, ctx) => publishForm(tx, ctx, form.id, captcha));
    expect(await resolvePublicForm(handle.db, slug)).not.toBeNull();
    const renamed = await inOrg(A(), aOwner(), (tx, ctx) =>
      updateForm(tx, ctx, form.id, { name: 'One renamed' }),
    );
    expect(renamed.changedFields).toEqual(['name']);

    await inOrg(A(), aOwner(), (tx, ctx) => setFormArchived(tx, ctx, form.id, true));
    expect(await resolvePublicForm(handle.db, slug)).toBeNull();
    const listed = await inOrg(A(), null, (tx) => listForms(tx, A().id, { status: 'archived' }));
    expect(listed.data.map((f) => f.id)).toContain(form.id);
    await inOrg(A(), aOwner(), (tx, ctx) => setFormArchived(tx, ctx, form.id, false));
    expect(await resolvePublicForm(handle.db, slug)).not.toBeNull();
    expect(await resolvePublicForm(handle.db, 'NOT A SLUG!')).toBeNull();
  });

  it('enforces forms.max for new and restored forms', async () => {
    const owner = await createTestUser(handle.db, { name: 'Limited owner' });
    const { organization } = await createOrganization(handle.db, owner.id, {
      name: `Limited ${uniqueSuffix()}`,
    });
    await withSystem(handle.db, async (tx) => {
      const plan = await createPlan(tx, {
        key: `forms-${uniqueSuffix()}`,
        name: 'Forms limited',
        isPublic: false,
      });
      const version = await createPlanVersion(tx, plan.id, { 'forms.max': 2 });
      await publishPlanVersion(tx, version.id);
      await startSubscription(tx, {
        organizationId: organization.id,
        planVersionId: version.id,
        status: 'active',
        provider: 'manual',
      });
    });
    const create = (name: string) =>
      inOrg(organization, owner.id, (tx, ctx) => createForm(tx, ctx, { name }));
    const results = await Promise.allSettled([create('One'), create('Two'), create('Three')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(EntitlementExceededError);

    const first = results.find((r) => r.status === 'fulfilled')?.value;
    if (!first) throw new Error('expected a form');
    await inOrg(organization, owner.id, (tx, ctx) => setFormArchived(tx, ctx, first.id, true));
    const third = await create('Three');
    await rejects(
      inOrg(organization, owner.id, (tx, ctx) => setFormArchived(tx, ctx, first.id, false)),
      EntitlementExceededError,
    );
    expect(third.status).toBe('active');
  });
});

describe('submissions', () => {
  it('creates a contact, tags it, opens a deal, adds a note and emits form.submitted', async () => {
    const tag = await inOrg(A(), null, (tx) =>
      createTag(tx, A().id, { name: `Web ${uniqueSuffix()}` }),
    );
    const pipeline = await inOrg(A(), null, (tx) => defaultPipeline(tx, A().id));
    await inOrg(A(), null, (tx) =>
      createCustomField(tx, A().id, {
        entityType: 'contact',
        key: `size_${uniqueSuffix()}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        label: 'Company size',
        type: 'select',
        options: [
          { value: 'small', label: '1–10' },
          { value: 'large', label: '11+' },
        ],
      }),
    ).then(async (custom) => {
      const form = await publishedForm({
        fields: [
          { key: 'name', type: 'text', label: 'Name', required: true, target: 'contact.fullName' },
          { key: 'email', type: 'email', label: 'Email', required: true, target: 'contact.email' },
          { key: 'phone', type: 'phone', label: 'Phone', target: 'contact.phone' },
          {
            key: 'size',
            type: 'radio',
            label: 'Company size',
            options: [{ value: 'large', label: '11+' }],
            target: `contact.custom.${custom.key}`,
          },
          { key: 'message', type: 'textarea', label: 'Message' },
        ],
        settings: {
          contact: {
            ownerUserId: world.orgA.users.sales.id,
            lifecycleStage: 'qualified',
            tagIds: [tag.id],
            addNote: true,
          },
          deal: { pipelineId: pipeline.id },
        },
      });
      const email = `lead-${uniqueSuffix()}@example.com`.toLowerCase();
      const result = await submitForm(
        handle.db,
        submission(form, {
          name: 'Maryam Al Sayed',
          email,
          phone: '3312 3456',
          size: 'large',
          message: 'We need a quote',
          ownerUserId: aOwner(),
          lifecycleStage: 'customer',
          tagIds: [],
          organizationId: B().id,
        }),
      );
      expect(result).toMatchObject({ status: 'accepted', duplicate: false });

      const contact = await contactByEmail(A(), email);
      expect(contact).toMatchObject({
        firstName: 'Maryam',
        lastName: 'Al Sayed',
        phone: '+97333123456',
        source: 'form',
        // Fixed by the form's settings, never by the submitter.
        ownerUserId: world.orgA.users.sales.id,
        lifecycleStage: 'qualified',
        organizationId: A().id,
      });
      const detail = await inOrg(A(), null, (tx, ctx) => getContact(tx, ctx, contact?.id ?? ''));
      expect(detail.tags.map((t) => t.id)).toEqual([tag.id]);
      expect(detail.customFields[custom.key]).toBe('large');

      const stored = await inOrg(A(), aOwner(), (tx, ctx) =>
        getSubmission(tx, ctx, form.id, result.submissionId),
      );
      expect(stored).toMatchObject({
        status: 'accepted',
        contact: { id: contact?.id, name: 'Maryam Al Sayed' },
        processingNotes: [],
      });
      expect(stored.answers.map((a) => a.key)).toEqual([
        'name',
        'email',
        'phone',
        'size',
        'message',
      ]);
      const [deal] = await inOrg(A(), null, (tx) =>
        tx
          .select()
          .from(crmDeals)
          .where(eq(crmDeals.id, stored.dealId ?? '')),
      );
      expect(deal).toMatchObject({
        contactId: contact?.id,
        ownerUserId: world.orgA.users.sales.id,
        currency: A().defaultCurrency,
        valueMinor: null,
      });
      const notes = await inOrg(A(), null, (tx) =>
        tx
          .select()
          .from(crmNotes)
          .where(eq(crmNotes.contactId, contact?.id ?? '')),
      );
      expect(notes[0]?.body).toContain('Message: We need a quote');

      // System scope: the outbox is not readable by tenants.
      const events = await withSystem(handle.db, (tx) =>
        tx
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.type, 'form.submitted'),
              eq(outboxEvents.subjectId, result.submissionId),
            ),
          ),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ contactId: contact?.id, dealId: deal?.id });

      // The contact timeline shows the submission.
      const event = events[0];
      if (!event) throw new Error('missing event');
      const loaded = await loadEvent(handle.db, event.id);
      if (!loaded) throw new Error('event not loadable');
      expect(await projectEvent(handle.db, formsTimelineProjectors, loaded)).toBe(true);
      const timeline = await inOrg(A(), null, (tx) =>
        tx.select().from(activities).where(eq(activities.sourceEventId, event.id)),
      );
      expect(timeline[0]).toMatchObject({ type: 'form.submitted', contactId: contact?.id });
      expect(timeline[0]?.summary).toBe(`Submitted ${form.name}`);
    });
  });

  it('only fills empty properties of an existing contact', async () => {
    const email = `known-${uniqueSuffix()}@example.com`.toLowerCase();
    const existing = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Ali', lastName: 'Hassan', email, jobTitle: null }),
    );
    const form = await publishedForm({
      fields: [
        { key: 'name', type: 'text', label: 'Name', target: 'contact.fullName' },
        { key: 'email', type: 'email', label: 'Email', required: true, target: 'contact.email' },
        { key: 'title', type: 'text', label: 'Job title', target: 'contact.jobTitle' },
        { key: 'phone', type: 'phone', label: 'Phone', target: 'contact.phone' },
      ],
    });
    await submitForm(
      handle.db,
      submission(form, { name: 'Impostor Name', email, title: 'Director', phone: '+97339001122' }),
    );
    const after = await contactByEmail(A(), email);
    expect(after).toMatchObject({
      id: existing.id,
      firstName: 'Ali',
      lastName: 'Hassan',
      jobTitle: 'Director',
      phone: '+97339001122',
      ownerUserId: aOwner(),
      source: 'manual',
    });
  });

  it('rejects invalid answers without storing anything', async () => {
    const form = await publishedForm();
    const before = await inOrg(A(), aOwner(), (tx, ctx) => listSubmissions(tx, ctx, form.id, {}));
    const error = await rejects(
      submitForm(handle.db, submission(form, { full_name: '', email: 'nope' })),
      ValidationError,
    );
    expect(error.details?.map((d) => d.path).sort()).toEqual([
      'answers.email',
      'answers.full_name',
    ]);
    const after = await inOrg(A(), aOwner(), (tx, ctx) => listSubmissions(tx, ctx, form.id, {}));
    expect(after.data).toHaveLength(before.data.length);
  });

  it('quarantines spam without touching the CRM, and staff can release it', async () => {
    const form = await publishedForm();
    const email = `bot-${uniqueSuffix()}@example.com`.toLowerCase();
    const spam = await submitForm(
      handle.db,
      submission(
        form,
        { full_name: 'Bot', email },
        { signals: { honeypot: 'https://cheap.example', elapsedMs: 50 } },
      ),
    );
    expect(spam.status).toBe('spam');
    expect(await contactByEmail(A(), email)).toBeUndefined();
    const spamList = await inOrg(A(), aOwner(), (tx, ctx) =>
      listSubmissions(tx, ctx, form.id, { status: 'spam' }),
    );
    expect(spamList.data.map((s) => s.id)).toEqual([spam.submissionId]);
    const accepted = await inOrg(A(), aOwner(), (tx, ctx) => listSubmissions(tx, ctx, form.id, {}));
    expect(accepted.data).toHaveLength(0);

    const released = await inOrg(A(), aOwner(), (tx, ctx) =>
      releaseSubmission(tx, ctx, form.id, spam.submissionId),
    );
    expect(released.status).toBe('accepted');
    expect((await contactByEmail(A(), email))?.id).toBe(released.contact?.id);
    await rejects(
      inOrg(A(), aOwner(), (tx, ctx) => releaseSubmission(tx, ctx, form.id, spam.submissionId)),
      ConflictError,
    );
  });

  it('accepts each rendered form once, even under concurrent double submits', async () => {
    const form = await publishedForm();
    const email = `twice-${uniqueSuffix()}@example.com`.toLowerCase();
    const input = submission(form, { full_name: 'Twice', email });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submitForm(handle.db, input)),
    );
    expect(new Set(results.map((r) => r.submissionId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const contacts = await inOrg(A(), null, (tx) =>
      tx.select().from(crmContacts).where(eq(crmContacts.email, email)),
    );
    expect(contacts).toHaveLength(1);
  });

  it('records what it could not do instead of losing the submission', async () => {
    const tag = await inOrg(A(), null, (tx) =>
      createTag(tx, A().id, { name: `Gone ${uniqueSuffix()}` }),
    );
    const form = await publishedForm({
      fields: [
        { key: 'email', type: 'email', label: 'Email', required: true, target: 'contact.email' },
      ],
      settings: { contact: { tagIds: [tag.id] } },
    });
    await inOrg(A(), null, (tx) => deleteTag(tx, A().id, tag.id));
    const result = await submitForm(
      handle.db,
      submission(form, { email: `notes-${uniqueSuffix()}@example.com`.toLowerCase() }),
    );
    const stored = await inOrg(A(), aOwner(), (tx, ctx) =>
      getSubmission(tx, ctx, form.id, result.submissionId),
    );
    expect(stored.contact).not.toBeNull();
    expect(stored.processingNotes).toEqual(['Some tags no longer exist and were skipped']);
  });

  it('keeps the submission and explains why when the contact quota is full', async () => {
    const owner = await createTestUser(handle.db, { name: 'Quota owner' });
    const { organization } = await createOrganization(handle.db, owner.id, {
      name: `Quota ${uniqueSuffix()}`,
    });
    await withSystem(handle.db, async (tx) => {
      const plan = await createPlan(tx, {
        key: `forms-quota-${uniqueSuffix()}`,
        name: 'No contacts',
        isPublic: false,
      });
      const version = await createPlanVersion(tx, plan.id, {
        'forms.max': 5,
        'crm.contacts.max': 0,
      });
      await publishPlanVersion(tx, version.id);
      await startSubscription(tx, {
        organizationId: organization.id,
        planVersionId: version.id,
        status: 'active',
        provider: 'manual',
      });
    });
    const form = await inOrg(organization, owner.id, async (tx, ctx) => {
      const created = await createForm(tx, ctx, { name: 'Quota form' });
      return publishForm(tx, ctx, created.id, captcha);
    });
    const result = await submitForm(handle.db, {
      ...submission(form, {
        full_name: 'Over Quota',
        email: `quota-${uniqueSuffix()}@example.com`.toLowerCase(),
      }),
      organizationId: organization.id,
    });
    expect(result.status).toBe('accepted');
    const stored = await inOrg(organization, owner.id, (tx, ctx) =>
      getSubmission(tx, ctx, form.id, result.submissionId),
    );
    expect(stored.contact).toBeNull();
    expect(stored.processingNotes).toEqual([
      "Contact not created: the plan's contact limit is reached",
    ]);
  });

  it('accepts answers to the version that was rendered after a republish, not drafts', async () => {
    const form = await publishedForm();
    const v1 = form.published?.id ?? '';
    await inOrg(A(), aOwner(), async (tx, ctx) => {
      await saveDraft(
        tx,
        ctx,
        form.id,
        { fields: [{ key: 'email', type: 'email', label: 'Email', target: 'contact.email' }] },
        captcha,
      );
      await publishForm(tx, ctx, form.id, captcha);
    });
    const old = await submitForm(
      handle.db,
      submission(
        form,
        { full_name: 'Old Version', email: `v1-${uniqueSuffix()}@example.com`.toLowerCase() },
        { versionId: v1 },
      ),
    );
    expect(old.status).toBe('accepted');
    const draft = await inOrg(A(), aOwner(), (tx, ctx) =>
      saveDraft(tx, ctx, form.id, { fields: [{ key: 'x', type: 'text', label: 'X' }] }, captcha),
    );
    await rejects(
      submitForm(handle.db, submission(form, { x: 'draft' }, { versionId: draft.draft?.id ?? '' })),
      NotFoundError,
    );
  });
});

describe('tenant isolation', () => {
  it('never reads, lists, edits or submits across organizations', async () => {
    const formA = await publishedForm();
    const bOwner = world.orgB.users.owner.id;
    const result = await submitForm(
      handle.db,
      submission(formA, {
        full_name: 'Iso',
        email: `iso-${uniqueSuffix()}@example.com`.toLowerCase(),
      }),
    );

    await rejects(
      inOrg(B(), bOwner, (tx) => getForm(tx, B().id, formA.id)),
      NotFoundError,
    );
    // Even naming A's organization id from inside B's scope finds nothing (RLS).
    await rejects(
      inOrg(B(), bOwner, (tx) => getForm(tx, A().id, formA.id)),
      NotFoundError,
    );
    const list = await inOrg(B(), bOwner, (tx) => listForms(tx, B().id));
    expect(list.data.map((f) => f.id)).not.toContain(formA.id);
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => updateForm(tx, ctx, formA.id, { name: 'Hijacked' })),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) =>
        saveDraft(tx, ctx, formA.id, { fields: [{ key: 'a', type: 'text', label: 'A' }] }, captcha),
      ),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => publishForm(tx, ctx, formA.id, captcha)),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => setFormArchived(tx, ctx, formA.id, true)),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => listSubmissions(tx, ctx, formA.id, {})),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => getSubmission(tx, ctx, formA.id, result.submissionId)),
      NotFoundError,
    );
    await rejects(
      inOrg(B(), bOwner, (tx, ctx) => releaseSubmission(tx, ctx, formA.id, result.submissionId)),
      NotFoundError,
    );
    // A submission addressed to B with A's form is refused.
    await rejects(
      submitForm(
        handle.db,
        submission(formA, { full_name: 'X', email: 'x@example.com' }, { organizationId: B().id }),
      ),
      NotFoundError,
    );
    const formB = await publishedForm(undefined, B());
    const rows = await inOrg(B(), bOwner, (tx) =>
      tx.select().from(formSubmissions).where(eq(formSubmissions.formId, formA.id)),
    );
    expect(rows).toHaveLength(0);
    await rejects(
      inOrg(A(), aOwner(), (tx) => getForm(tx, A().id, formB.id)),
      NotFoundError,
    );
  });
});
