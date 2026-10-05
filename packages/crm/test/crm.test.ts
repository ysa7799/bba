import {
  createPlan,
  createPlanVersion,
  publishPlanVersion,
  startSubscription,
} from '@businessos/billing';
import {
  crmContacts,
  crmDeals,
  outboxEvents,
  pgErrorInfo,
  PG_ERROR,
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
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@businessos/shared';
import {
  addTestMember,
  createTestDatabase,
  createTestUser,
  createTestWorld,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addStage,
  archivePipeline,
  bulkUpdateContacts,
  cancelImport,
  createCompany,
  createContact,
  createCustomField,
  createDeal,
  createImport,
  createNote,
  createPipeline,
  createTag,
  createTask,
  dealBoard,
  deleteContact,
  deleteNote,
  deleteStage,
  downloadExport,
  getContact,
  getDeal,
  getImport,
  linkContactCompany,
  listContacts,
  listPipelines,
  listTasks,
  moveDeal,
  previewImport,
  processExport,
  processImport,
  requestExport,
  searchCrm,
  startImport,
  updateContact,
  updateCustomField,
  updateDeal,
  updateImportMapping,
  updateNote,
  updateStage,
  updateTask,
  type CrmContext,
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

function ctxFor(
  org: Organization,
  userId: string | null,
  overrides: Partial<CrmContext> = {},
): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: 'user', userId },
    ...overrides,
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

const A = () => world.orgA.organization;
const B = () => world.orgB.organization;
const aOwner = () => world.orgA.users.owner.id;
const bOwner = () => world.orgB.users.owner.id;

async function expectError<E>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(type);
  return error as E;
}

/** A fresh organization on a plan with the given entitlement values. */
async function orgOnPlan(values: Record<string, unknown>) {
  const owner = await createTestUser(handle.db, { name: 'Limited owner' });
  const { organization } = await createOrganization(handle.db, owner.id, {
    name: `Limited ${uniqueSuffix()}`,
  });
  await withSystem(handle.db, async (tx) => {
    const plan = await createPlan(tx, {
      key: `crm-${uniqueSuffix()}`,
      name: 'CRM limited',
      isPublic: false,
    });
    const version = await createPlanVersion(tx, plan.id, values);
    await publishPlanVersion(tx, version.id);
    await startSubscription(tx, {
      organizationId: organization.id,
      planVersionId: version.id,
      status: 'active',
      provider: 'manual',
    });
  });
  return { organization, owner };
}

describe('contacts', () => {
  it('normalizes channels, defaults the owner and emits contact.created', async () => {
    const contact = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, {
        firstName: '  Fatima ',
        lastName: 'Al Khalifa',
        email: ' Fatima.K@Example.COM ',
        phone: '3312 3456',
        whatsappPhone: '+973 3998 7654',
        jobTitle: 'Procurement lead',
      }),
    );
    expect(contact).toMatchObject({
      firstName: 'Fatima',
      displayName: 'Fatima Al Khalifa',
      email: 'fatima.k@example.com',
      phone: '+97333123456',
      whatsappPhone: '+97339987654',
      ownerUserId: aOwner(),
      lifecycleStage: 'lead',
      status: 'active',
      source: 'manual',
    });
    const events = await withSystem(handle.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.subjectId, contact.id)),
    );
    expect(events.map((event) => event.type)).toEqual(['contact.created']);
    expect(events[0]?.organizationId).toBe(A().id);
  });

  it('requires a name, email or phone and rejects invalid values', async () => {
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => createContact(tx, ctx, { jobTitle: 'CEO' })),
      ValidationError,
    );
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => createContact(tx, ctx, { email: 'nope' })),
      ValidationError,
    );
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => createContact(tx, ctx, { phone: '123' })),
      ValidationError,
    );
  });

  it('rejects duplicate emails within an organization but not across organizations', async () => {
    const email = `dup.${uniqueSuffix()}@example.com`;
    await inOrg(A(), aOwner(), (tx, ctx) => createContact(tx, ctx, { email }));
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => createContact(tx, ctx, { email: email.toUpperCase() })),
      ConflictError,
    );
    const inB = await inOrg(B(), bOwner(), (tx, ctx) => createContact(tx, ctx, { email }));
    expect(inB.email).toBe(email);
  });

  it('only assigns active members of the same organization as owner', async () => {
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) =>
        createContact(tx, ctx, { firstName: 'X', ownerUserId: bOwner() }),
      ),
      ValidationError,
    );
    const suspended = await createTestUser(handle.db, { name: 'Suspended' });
    await addTestMember(handle.db, A().id, suspended.id, { status: 'suspended' });
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) =>
        createContact(tx, ctx, { firstName: 'X', ownerUserId: suspended.id }),
      ),
      ValidationError,
    );
    const ok = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Y', ownerUserId: world.orgA.users.sales.id }),
    );
    expect(ok.ownerName).toBe(world.orgA.users.sales.name);
  });

  it('updates only changed fields, records changed fields and soft-deletes', async () => {
    const contact = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Omar' }),
    );
    const { changedFields, after } = await inOrg(A(), aOwner(), (tx, ctx) =>
      updateContact(tx, ctx, contact.id, {
        firstName: 'Omar',
        lastName: 'Haddad',
        lifecycleStage: 'customer',
      }),
    );
    expect(changedFields).toEqual(['lastName', 'lifecycleStage']);
    expect(after.displayName).toBe('Omar Haddad');
    const noop = await inOrg(A(), aOwner(), (tx, ctx) =>
      updateContact(tx, ctx, contact.id, { firstName: 'Omar' }),
    );
    expect(noop.changedFields).toEqual([]);
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) =>
        updateContact(tx, ctx, contact.id, { firstName: null, lastName: null }),
      ),
      ValidationError,
    );
    await inOrg(A(), aOwner(), (tx, ctx) => deleteContact(tx, ctx, contact.id));
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => getContact(tx, ctx, contact.id)),
      NotFoundError,
    );
    const listed = await inOrg(A(), aOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 100, sort: 'created_desc', q: 'Haddad' }),
    );
    expect(listed.data.map((c) => c.id)).not.toContain(contact.id);
  });

  it('links companies with a single primary company', async () => {
    const result = await inOrg(A(), aOwner(), async (tx, ctx) => {
      const first = await createCompany(tx, ctx, { name: `Gulf Trading ${uniqueSuffix()}` });
      const second = await createCompany(tx, ctx, { name: `Bahrain Steel ${uniqueSuffix()}` });
      const contact = await createContact(tx, ctx, { firstName: 'Link', companyId: first.id });
      await linkContactCompany(tx, ctx, contact.id, {
        companyId: second.id,
        role: 'Advisor',
        isPrimary: true,
      });
      return { contact: await getContact(tx, ctx, contact.id), first, second };
    });
    expect(result.contact.primaryCompany?.id).toBe(result.second.id);
    expect(result.contact.companies.filter((link) => link.isPrimary)).toHaveLength(1);
    expect(result.contact.companies).toHaveLength(2);
  });

  it('searches names in English and Arabic by prefix and phones by digits', async () => {
    const tag = uniqueSuffix();
    await inOrg(A(), aOwner(), async (tx, ctx) => {
      await createContact(tx, ctx, {
        firstName: `Khalid${tag}`,
        lastName: 'Rahman',
        phone: '3655 1234',
      });
      await createContact(tx, ctx, { firstName: 'محمد', lastName: `الخليفة${tag}` });
    });
    const byPrefix = await inOrg(A(), aOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', q: `khalid${tag}`.slice(0, -2) }),
    );
    expect(byPrefix.data.some((c) => c.firstName === `Khalid${tag}`)).toBe(true);
    const arabic = await inOrg(A(), aOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', q: `محمد الخليفة${tag}` }),
    );
    expect(arabic.data).toHaveLength(1);
    const byPhone = await inOrg(A(), aOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', q: '3655 12' }),
    );
    expect(byPhone.data.some((c) => c.phone === '+97336551234')).toBe(true);
    const inB = await inOrg(B(), bOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', q: `Khalid${tag}` }),
    );
    expect(inB.data).toHaveLength(0);
  });

  it('paginates every sort order without skipping or repeating rows', async () => {
    const { organization, owner } = await orgOnPlan({ 'crm.contacts.max': null });
    await inOrg(organization, owner.id, async (tx, ctx) => {
      for (const name of ['delta', 'alpha', 'Charlie', 'bravo', 'echo', 'alpha']) {
        await createContact(tx, ctx, { firstName: name });
      }
    });
    for (const sort of [
      'created_desc',
      'created_asc',
      'updated_desc',
      'name_asc',
      'name_desc',
    ] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await inOrg(organization, owner.id, (tx, ctx) =>
          listContacts(tx, ctx, { limit: 2, sort, cursor }),
        );
        seen.push(...page.data.map((c) => c.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(seen).size).toBe(6);
      expect(seen).toHaveLength(6);
    }
    const names = await inOrg(organization, owner.id, (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'name_asc' }),
    );
    expect(names.data.map((c) => c.firstName)).toEqual([
      'alpha',
      'alpha',
      'bravo',
      'Charlie',
      'delta',
      'echo',
    ]);
  });

  it('bulk actions only touch live contacts of the caller organization', async () => {
    const mine = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Bulk A' }),
    );
    const theirs = await inOrg(B(), bOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Bulk B' }),
    );
    const result = await inOrg(A(), aOwner(), (tx, ctx) =>
      bulkUpdateContacts(tx, ctx, {
        action: 'set_lifecycle',
        ids: [mine.id, theirs.id],
        lifecycleStage: 'customer',
      }),
    );
    expect(result).toEqual({ affected: 1, ids: [mine.id] });
    const deleted = await inOrg(A(), aOwner(), (tx, ctx) =>
      bulkUpdateContacts(tx, ctx, { action: 'delete', ids: [theirs.id] }),
    );
    expect(deleted.affected).toBe(0);
    const stillThere = await inOrg(B(), bOwner(), (tx, ctx) => getContact(tx, ctx, theirs.id));
    expect(stillThere.lifecycleStage).toBe('lead');
  });

  it('tags: add, replace and filter; foreign tags are rejected', async () => {
    const { tagA, tagB } = await inOrg(A(), aOwner(), async (tx) => ({
      tagA: await createTag(tx, A().id, { name: `VIP ${uniqueSuffix()}`, color: 'amber' }),
      tagB: await createTag(tx, A().id, { name: `Wholesale ${uniqueSuffix()}` }),
    }));
    const bTag = await inOrg(B(), bOwner(), (tx) =>
      createTag(tx, B().id, { name: `B tag ${uniqueSuffix()}` }),
    );
    const contact = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Tagged', tagIds: [tagA.id] }),
    );
    await expectError(
      inOrg(A(), aOwner(), (tx, ctx) => updateContact(tx, ctx, contact.id, { tagIds: [bTag.id] })),
      ValidationError,
    );
    const { after, changedFields } = await inOrg(A(), aOwner(), (tx, ctx) =>
      updateContact(tx, ctx, contact.id, { tagIds: [tagB.id] }),
    );
    expect(changedFields).toEqual(['tags']);
    expect(after.tags.map((t) => t.id)).toEqual([tagB.id]);
    const filtered = await inOrg(A(), aOwner(), (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', tagId: tagB.id }),
    );
    expect(filtered.data.map((c) => c.id)).toEqual([contact.id]);
  });
});

describe('custom fields', () => {
  it('validates values by type, enforces required fields and filters by value', async () => {
    const { organization, owner } = await orgOnPlan({});
    const values = await inOrg(organization, owner.id, async (tx, ctx) => {
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'tier',
        label: 'Tier',
        type: 'select',
        options: [
          { value: 'gold', label: 'Gold' },
          { value: 'silver', label: 'Silver' },
        ],
        required: true,
      });
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'spend',
        label: 'Spend',
        type: 'decimal',
      });
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'vip',
        label: 'VIP',
        type: 'boolean',
      });
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'renewal',
        label: 'Renewal',
        type: 'date',
      });
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'manager',
        label: 'Manager',
        type: 'user',
      });
      await createCustomField(tx, organization.id, {
        entityType: 'contact',
        key: 'interests',
        label: 'Interests',
        type: 'multi_select',
        options: [
          { value: 'steel', label: 'Steel' },
          { value: 'aluminium', label: 'Aluminium' },
        ],
      });
      const contact = await createContact(tx, ctx, {
        firstName: 'Custom',
        customFields: {
          tier: 'gold',
          spend: '1250.500',
          vip: true,
          renewal: '2026-12-31',
          manager: owner.id,
          interests: ['steel', 'steel', 'aluminium'],
        },
      });
      return contact.customFields;
    });
    expect(values).toEqual({
      tier: 'gold',
      spend: '1250.500',
      vip: true,
      renewal: '2026-12-31',
      manager: owner.id,
      interests: ['steel', 'aluminium'],
    });

    const invalid: Record<string, unknown>[] = [
      {},
      { tier: 'platinum' },
      { tier: 'gold', spend: 1.5e300 },
      { tier: 'gold', spend: 'abc' },
      { tier: 'gold', vip: 'maybe' },
      { tier: 'gold', renewal: '2026-02-30' },
      { tier: 'gold', manager: world.orgB.users.owner.id },
      { tier: 'gold', interests: ['gold'] },
      { tier: 'gold', unknown_field: 'x' },
    ];
    for (const customFields of invalid) {
      await expectError(
        inOrg(organization, owner.id, (tx, ctx) =>
          createContact(tx, ctx, { firstName: 'Bad', customFields }),
        ),
        ValidationError,
      );
    }

    const filtered = await inOrg(organization, owner.id, (tx, ctx) =>
      listContacts(tx, ctx, {
        limit: 10,
        sort: 'created_desc',
        customFields: { tier: 'gold', vip: 'true' },
      }),
    );
    expect(filtered.data).toHaveLength(1);
    const none = await inOrg(organization, owner.id, (tx, ctx) =>
      listContacts(tx, ctx, { limit: 10, sort: 'created_desc', customFields: { tier: 'silver' } }),
    );
    expect(none.data).toHaveLength(0);
  });

  it('keeps key and type immutable, rejects duplicates and hides archived fields', async () => {
    const { organization, owner } = await orgOnPlan({});
    const field = await inOrg(organization, owner.id, (tx) =>
      createCustomField(tx, organization.id, {
        entityType: 'company',
        key: 'region',
        label: 'Region',
        type: 'text',
      }),
    );
    await expectError(
      inOrg(organization, owner.id, (tx) =>
        createCustomField(tx, organization.id, {
          entityType: 'company',
          key: 'region',
          label: 'Again',
          type: 'text',
        }),
      ),
      ConflictError,
    );
    await expectError(
      inOrg(organization, owner.id, (tx) =>
        createCustomField(tx, organization.id, {
          entityType: 'company',
          key: 'Bad Key',
          label: 'x',
          type: 'text',
        }),
      ),
      Error,
    );
    const company = await inOrg(organization, owner.id, (tx, ctx) =>
      createCompany(tx, ctx, { name: 'Region Co', customFields: { region: 'Muharraq' } }),
    );
    expect(company.customFields).toEqual({ region: 'Muharraq' });
    await inOrg(organization, owner.id, (tx) =>
      updateCustomField(tx, organization.id, field.id, { archived: true }),
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        createCompany(tx, ctx, { name: 'Other', customFields: { region: 'x' } }),
      ),
      ValidationError,
    );
  });
});

describe('tenant isolation', () => {
  it('row-level security hides other tenants even for direct queries', async () => {
    const secret = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Secret' }),
    );
    const fromB = await withTenant(handle.db, { organizationId: B().id, userId: bOwner() }, (tx) =>
      tx.select().from(crmContacts).where(eq(crmContacts.id, secret.id)),
    );
    expect(fromB).toHaveLength(0);
    const updated = await withTenant(
      handle.db,
      { organizationId: B().id, userId: bOwner() },
      (tx) =>
        tx
          .update(crmContacts)
          .set({ firstName: 'Hacked' })
          .where(eq(crmContacts.id, secret.id))
          .returning(),
    );
    expect(updated).toHaveLength(0);
    const insertForA = withTenant(handle.db, { organizationId: B().id, userId: bOwner() }, (tx) =>
      tx.insert(crmContacts).values({ organizationId: A().id, firstName: 'Injected' }),
    );
    const error = await insertForA.catch((caught: unknown) => caught);
    expect(pgErrorInfo(error)?.code).toBe(PG_ERROR.insufficientPrivilege);
  });

  it('services return not found for guessed ids from another organization', async () => {
    const { contact, company, deal } = await inOrg(A(), aOwner(), async (tx, ctx) => {
      const company = await createCompany(tx, ctx, { name: `Iso ${uniqueSuffix()}` });
      const contact = await createContact(tx, ctx, { firstName: 'Iso', companyId: company.id });
      const deal = await createDeal(tx, ctx, { name: 'Iso deal', contactId: contact.id });
      return { contact, company, deal };
    });
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => getContact(tx, ctx, contact.id)),
      NotFoundError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => getDeal(tx, ctx, deal.id)),
      NotFoundError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => updateContact(tx, ctx, contact.id, { firstName: 'x' })),
      NotFoundError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => deleteContact(tx, ctx, contact.id)),
      NotFoundError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) =>
        createNote(tx, ctx, { type: 'contact', id: contact.id }, { body: 'x' }),
      ),
      NotFoundError,
    );
    // References from B to A's records are rejected by the service…
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) =>
        createDeal(tx, ctx, { name: 'Steal', contactId: contact.id }),
      ),
      ValidationError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) =>
        createContact(tx, ctx, { firstName: 'x', companyId: company.id }),
      ),
      ValidationError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => createTask(tx, ctx, { title: 'x', dealId: deal.id })),
      ValidationError,
    );
    // …and by the composite foreign keys underneath it.
    const bPipeline = (await inOrg(B(), bOwner(), (tx) => listPipelines(tx, B().id)))[0];
    const rawInsert = withTenant(handle.db, { organizationId: B().id, userId: bOwner() }, (tx) =>
      tx.insert(crmDeals).values({
        organizationId: B().id,
        name: 'raw',
        pipelineId: bPipeline?.id ?? '',
        stageId: bPipeline?.stages[0]?.id ?? '',
        contactId: contact.id,
        currency: 'BHD',
      }),
    );
    expect(pgErrorInfo(await rawInsert.catch((caught: unknown) => caught))?.code).toBe(
      PG_ERROR.foreignKeyViolation,
    );
    // Stages of another tenant's pipeline cannot be used either.
    const aPipeline = (await inOrg(A(), aOwner(), (tx) => listPipelines(tx, A().id)))[0];
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) =>
        createDeal(tx, ctx, {
          name: 'x',
          pipelineId: aPipeline?.id,
          stageId: aPipeline?.stages[0]?.id,
        }),
      ),
      ValidationError,
    );
    const search = await inOrg(B(), bOwner(), (tx, ctx) => searchCrm(tx, ctx, 'Iso'));
    expect(search.filter((hit) => [contact.id, company.id, deal.id].includes(hit.id))).toHaveLength(
      0,
    );
  });

  it('withholds linked record names the caller cannot read', async () => {
    const { deal } = await inOrg(A(), aOwner(), async (tx, ctx) => {
      const contact = await createContact(tx, ctx, { firstName: 'Hidden', lastName: 'Person' });
      return { deal: await createDeal(tx, ctx, { name: 'Visible deal', contactId: contact.id }) };
    });
    const visible = await inOrg(A(), aOwner(), (tx, ctx) => getDeal(tx, ctx, deal.id));
    expect(visible.contact?.name).toBe('Hidden Person');
    const redacted = await withTenant(
      handle.db,
      { organizationId: A().id, userId: aOwner() },
      (tx) =>
        getDeal(
          tx,
          ctxFor(A(), aOwner(), { canRead: { contact: false, company: true, deal: true } }),
          deal.id,
        ),
    );
    expect(redacted.contact).toBeNull();
  });
});

describe('entitlements', () => {
  it('enforces crm.contacts.max, including under concurrency', async () => {
    const { organization, owner } = await orgOnPlan({ 'crm.contacts.max': 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        inOrg(organization, owner.id, (tx, ctx) => createContact(tx, ctx, { firstName: `C${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(EntitlementExceededError);
    }
  });

  it('enforces crm.pipelines.max (the default pipeline counts)', async () => {
    const { organization, owner } = await orgOnPlan({ 'crm.pipelines.max': 1 });
    const pipelines = await inOrg(organization, owner.id, (tx) =>
      listPipelines(tx, organization.id),
    );
    expect(pipelines).toHaveLength(1);
    await expectError(
      inOrg(organization, owner.id, (tx) =>
        createPipeline(tx, organization.id, { name: 'Second' }),
      ),
      EntitlementExceededError,
    );
  });
});

describe('pipelines and deals', () => {
  it('creates exactly one default pipeline even when first requests race', async () => {
    const { organization, owner } = await orgOnPlan({});
    const lists = await Promise.all(
      Array.from({ length: 4 }, () =>
        inOrg(organization, owner.id, (tx) => listPipelines(tx, organization.id)),
      ),
    );
    for (const list of lists) expect(list).toHaveLength(1);
    expect(lists[0]?.[0]).toMatchObject({ name: 'Sales pipeline', isDefault: true });
    expect(lists[0]?.[0]?.stages.map((s) => s.kind)).toEqual([
      'open',
      'open',
      'open',
      'open',
      'won',
      'lost',
    ]);
  });

  it('moves deals through stages: won/lost close, reopening clears, events follow', async () => {
    const { organization, owner } = await orgOnPlan({});
    const ctxOrg = organization;
    const pipeline = (await inOrg(ctxOrg, owner.id, (tx) => listPipelines(tx, ctxOrg.id)))[0];
    if (!pipeline) throw new Error('no pipeline');
    const [lead, , , , won, lost] = pipeline.stages;
    if (!lead || !won || !lost) throw new Error('stages');
    const deal = await inOrg(ctxOrg, owner.id, (tx, ctx) =>
      createDeal(tx, ctx, {
        name: 'Steel supply',
        value: { amount: '12500.250', currency: 'BHD' },
      }),
    );
    expect(deal).toMatchObject({
      stageId: lead.id,
      status: 'open',
      value: { amount: '12500.250', currency: 'BHD' },
      probability: 10,
    });
    const wonResult = await inOrg(ctxOrg, owner.id, (tx, ctx) =>
      moveDeal(tx, ctx, deal.id, { stageId: won.id }),
    );
    expect(wonResult.after.status).toBe('won');
    expect(wonResult.after.closedAt).not.toBeNull();
    const lostResult = await inOrg(ctxOrg, owner.id, (tx, ctx) =>
      moveDeal(tx, ctx, deal.id, { stageId: lost.id, lostReason: 'Price' }),
    );
    expect(lostResult.after).toMatchObject({ status: 'lost', lostReason: 'Price' });
    const reopened = await inOrg(ctxOrg, owner.id, (tx, ctx) =>
      moveDeal(tx, ctx, deal.id, { stageId: lead.id }),
    );
    expect(reopened.after).toMatchObject({ status: 'open', closedAt: null, lostReason: null });
    const events = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.subjectId, deal.id))
        .orderBy(outboxEvents.id),
    );
    expect(events.map((e) => e.type)).toEqual([
      'deal.created',
      'deal.stage_changed',
      'deal.won',
      'deal.stage_changed',
      'deal.lost',
      'deal.stage_changed',
    ]);
    expect(events[2]?.payload).toEqual({
      dealId: deal.id,
      valueMinor: '12500250',
      currency: 'BHD',
    });
  });

  it('orders the board with fractional positions and totals values per currency', async () => {
    const { organization, owner } = await orgOnPlan({});
    const board = await inOrg(organization, owner.id, async (tx, ctx) => {
      const pipeline = (await listPipelines(tx, organization.id))[0];
      const stageId = pipeline?.stages[1]?.id;
      if (!pipeline || !stageId) throw new Error('pipeline');
      const d1 = await createDeal(tx, ctx, {
        name: 'D1',
        stageId,
        value: { amount: '1.500', currency: 'BHD' },
      });
      const d2 = await createDeal(tx, ctx, {
        name: 'D2',
        stageId,
        value: { amount: '0.250', currency: 'BHD' },
      });
      const d3 = await createDeal(tx, ctx, {
        name: 'D3',
        stageId,
        value: { amount: '100.00', currency: 'SAR' },
      });
      // New deals land on top: D3, D2, D1. Move D1 between D3 and D2, then D3 to the bottom.
      await moveDeal(tx, ctx, d1.id, { stageId, afterDealId: d3.id, beforeDealId: d2.id });
      await moveDeal(tx, ctx, d3.id, { stageId, afterDealId: d2.id });
      // Many moves into the same gap force a renormalization without breaking order.
      for (let i = 0; i < 60; i += 1) {
        await moveDeal(tx, ctx, i % 2 === 0 ? d2.id : d1.id, {
          stageId,
          afterDealId: i % 2 === 0 ? d1.id : d2.id,
          beforeDealId: d3.id,
        });
      }
      return dealBoard(tx, ctx, pipeline.id, { perStage: 50 });
    });
    const stage = board.stages[1];
    expect(stage?.deals.map((d) => d.name)).toEqual(['D2', 'D1', 'D3']);
    expect(stage?.count).toBe(3);
    expect(stage?.totals).toEqual([
      { amount: '1.750', currency: 'BHD' },
      { amount: '100.00', currency: 'SAR' },
    ]);
  });

  it('rejects negative values and keeps currency changes explicit', async () => {
    const { organization, owner } = await orgOnPlan({});
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        createDeal(tx, ctx, { name: 'Neg', value: { amount: '-1.000', currency: 'BHD' } }),
      ),
      Error,
    );
    const deal = await inOrg(organization, owner.id, (tx, ctx) =>
      createDeal(tx, ctx, { name: 'Cur', value: { amount: '5.000', currency: 'BHD' } }),
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) => updateDeal(tx, ctx, deal.id, { currency: 'USD' })),
      ValidationError,
    );
    const { after } = await inOrg(organization, owner.id, (tx, ctx) =>
      updateDeal(tx, ctx, deal.id, { value: { amount: '20.00', currency: 'USD' } }),
    );
    expect(after.value).toEqual({ amount: '20.00', currency: 'USD' });
  });

  it('protects pipeline structure', async () => {
    const { organization, owner } = await orgOnPlan({});
    await inOrg(organization, owner.id, async (tx, ctx) => {
      const pipeline = (await listPipelines(tx, organization.id))[0];
      const open = pipeline?.stages[0];
      if (!pipeline || !open) throw new Error('pipeline');
      await createDeal(tx, ctx, { name: 'Blocking', stageId: open.id });
      await expect(deleteStage(tx, organization.id, pipeline.id, open.id)).rejects.toBeInstanceOf(
        ConflictError,
      );
      await expect(
        updateStage(tx, organization.id, pipeline.id, open.id, { kind: 'won' }),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(archivePipeline(tx, organization.id, pipeline.id)).rejects.toBeInstanceOf(
        ConflictError,
      );
      const added = await addStage(tx, organization.id, pipeline.id, {
        name: 'Demo',
        probability: 40,
      });
      // New open stages are inserted before the closing stages.
      expect(added.stages.map((s) => s.name)).toEqual([
        'Lead',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Demo',
        'Won',
        'Lost',
      ]);
    });
  });
});

describe('tasks and notes', () => {
  it('filters by due window in the organization timezone and emits task.completed', async () => {
    const { organization, owner } = await orgOnPlan({});
    const now = Date.now();
    const ids = await inOrg(organization, owner.id, async (tx, ctx) => ({
      overdue: (
        await createTask(tx, ctx, {
          title: 'Overdue',
          dueAt: new Date(now - 86_400_000 * 2).toISOString(),
        })
      ).id,
      upcoming: (
        await createTask(tx, ctx, {
          title: 'Upcoming',
          dueAt: new Date(now + 86_400_000 * 3).toISOString(),
        })
      ).id,
      none: (await createTask(tx, ctx, { title: 'Someday' })).id,
    }));
    const overdue = await inOrg(organization, owner.id, (tx, ctx) =>
      listTasks(tx, ctx, { limit: 10, sort: 'due_asc', due: 'overdue' }),
    );
    expect(overdue.data.map((t) => t.id)).toEqual([ids.overdue]);
    const upcoming = await inOrg(organization, owner.id, (tx, ctx) =>
      listTasks(tx, ctx, { limit: 10, sort: 'due_asc', due: 'upcoming', assigneeUserId: 'me' }),
    );
    expect(upcoming.data.map((t) => t.id)).toEqual([ids.upcoming]);
    const all = await inOrg(organization, owner.id, (tx, ctx) =>
      listTasks(tx, ctx, { limit: 10, sort: 'due_asc' }),
    );
    expect(all.data.map((t) => t.id)).toEqual([ids.overdue, ids.upcoming, ids.none]);
    const { after } = await inOrg(organization, owner.id, (tx, ctx) =>
      updateTask(tx, ctx, ids.overdue, { status: 'completed' }),
    );
    expect(after.completedAt).not.toBeNull();
    const events = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.subjectId, ids.overdue),
            inArray(outboxEvents.type, ['task.created', 'task.completed']),
          ),
        ),
    );
    expect(events.map((e) => e.type).sort()).toEqual(['task.completed', 'task.created']);
  });

  it('lets authors edit their notes and moderators edit any note', async () => {
    const contact = await inOrg(A(), aOwner(), (tx, ctx) =>
      createContact(tx, ctx, { firstName: 'Noted' }),
    );
    const sales = world.orgA.users.sales.id;
    const note = await inOrg(A(), sales, (tx, ctx) =>
      createNote(tx, ctx, { type: 'contact', id: contact.id }, { body: 'Called, wants a quote' }),
    );
    expect(note.authorUserId).toBe(sales);
    await expectError(
      inOrg(A(), world.orgA.users.manager.id, (tx, ctx) =>
        updateNote(tx, ctx, note.id, { body: 'x' }, { canModerate: false }),
      ),
      ForbiddenError,
    );
    const edited = await inOrg(A(), sales, (tx, ctx) =>
      updateNote(tx, ctx, note.id, { body: 'Quote sent' }, { canModerate: false }),
    );
    expect(edited.body).toBe('Quote sent');
    await inOrg(A(), world.orgA.users.manager.id, (tx, ctx) =>
      deleteNote(tx, ctx, note.id, { canModerate: true }),
    );
  });
});

describe('import and export', () => {
  it('imports contacts with mapping, duplicates policy, formula unescaping and limits', async () => {
    const { organization, owner } = await orgOnPlan({ 'crm.contacts.max': 4 });
    await inOrg(organization, owner.id, (tx, ctx) =>
      createContact(tx, ctx, { email: 'existing@example.com', firstName: 'Old' }),
    );
    const csv = [
      '﻿First name;Last name;Email;Mobile;Company;Tags;Lifecycle',
      'Sara;Ali;sara@example.com;3312 0001;Gulf Steel;VIP, Wholesale;customer',
      'Existing;Person;EXISTING@example.com;;;;',
      'Bad;Phone;bad@example.com;12;;;',
      "'=cmd;Formula;formula@example.com;;;;",
      ';;;;;;',
      'Over;Limit;over@example.com;;;;',
      'Too;Many;many@example.com;;;;',
    ].join('\r\n');
    const created = await inOrg(organization, owner.id, (tx, ctx) =>
      createImport(tx, ctx, { entityType: 'contact', fileName: 'leads.csv', content: csv }),
    );
    expect(created.totalRows).toBe(7);
    expect(created.mapping).toEqual({
      '0': 'first_name',
      '1': 'last_name',
      '2': 'email',
      '3': 'phone',
      '4': 'company_name',
      '5': 'tags',
      '6': 'lifecycle_stage',
    });
    const preview = await inOrg(organization, owner.id, (tx, ctx) =>
      previewImport(tx, ctx, created.id),
    );
    expect(preview.find((row) => row.rowNumber === 3)?.error).toMatch(/phone/i);
    await inOrg(organization, owner.id, (tx, ctx) =>
      updateImportMapping(tx, ctx, created.id, {
        mapping: created.mapping,
        duplicatePolicy: 'update',
      }),
    );
    await inOrg(organization, owner.id, (tx, ctx) => startImport(tx, ctx, created.id));
    expect(await processImport(handle.db, organization.id, created.id, { batchSize: 3 })).toBe(
      'completed',
    );
    const detail = await inOrg(organization, owner.id, (tx) =>
      getImport(tx, organization.id, created.id),
    );
    expect(detail).toMatchObject({
      status: 'completed',
      processedRows: 7,
      createdCount: 3,
      updatedCount: 1,
      skippedCount: 1,
      failedCount: 2,
    });
    expect(detail.errors.map((e) => e.rowNumber)).toEqual([3, 7]);
    expect(detail.errors[1]?.error).toMatch(/limit/i);
    const contacts = await inOrg(organization, owner.id, (tx, ctx) =>
      listContacts(tx, ctx, { limit: 20, sort: 'created_asc' }),
    );
    const sara = contacts.data.find((c) => c.email === 'sara@example.com');
    expect(sara).toMatchObject({
      phone: '+97333120001',
      lifecycleStage: 'customer',
      source: 'import',
    });
    expect(sara?.primaryCompany?.name).toBe('Gulf Steel');
    expect(sara?.tags.map((t) => t.name).sort()).toEqual(['VIP', 'Wholesale']);
    expect(contacts.data.find((c) => c.email === 'existing@example.com')?.firstName).toBe(
      'Existing',
    );
    expect(contacts.data.find((c) => c.email === 'formula@example.com')?.firstName).toBe('=cmd');
    // Re-running a finished import does nothing.
    expect(await processImport(handle.db, organization.id, created.id)).toBe('skipped');
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) => startImport(tx, ctx, created.id)),
      ConflictError,
    );
  });

  it('honours cancellation and rejects bad mappings', async () => {
    const { organization, owner } = await orgOnPlan({});
    const imp = await inOrg(organization, owner.id, (tx, ctx) =>
      createImport(tx, ctx, {
        entityType: 'company',
        fileName: 'co.csv',
        content: 'Company,Website\nAcme,acme.example\n',
      }),
    );
    expect(imp.mapping).toEqual({ '0': 'name', '1': 'website' });
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        updateImportMapping(tx, ctx, imp.id, { mapping: { '1': 'website' } }),
      ),
      ValidationError,
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        updateImportMapping(tx, ctx, imp.id, { mapping: { '0': 'name', '1': 'name' } }),
      ),
      ValidationError,
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        updateImportMapping(tx, ctx, imp.id, { mapping: { '7': 'name' } }),
      ),
      ValidationError,
    );
    await inOrg(organization, owner.id, (tx, ctx) => startImport(tx, ctx, imp.id));
    await inOrg(organization, owner.id, (tx, ctx) => cancelImport(tx, ctx, imp.id));
    expect(await processImport(handle.db, organization.id, imp.id)).toBe('canceled');
    await expectError(
      inOrg(B(), bOwner(), (tx) => getImport(tx, B().id, imp.id)),
      NotFoundError,
    );
  });

  it('exports CSV with formula escaping, only for its creator', async () => {
    const { organization, owner } = await orgOnPlan({});
    const other = await createTestUser(handle.db, { name: 'Other member' });
    await addTestMember(handle.db, organization.id, other.id, { role: 'admin' });
    await inOrg(organization, owner.id, async (tx, ctx) => {
      await createContact(tx, ctx, {
        firstName: '=HYPERLINK("http://evil")',
        email: 'x@example.com',
      });
      await createContact(tx, ctx, { firstName: 'نور', lastName: 'Inactive', status: 'inactive' });
    });
    const requested = await inOrg(organization, owner.id, (tx, ctx) =>
      requestExport(tx, ctx, { entityType: 'contact', filters: { status: 'active' } }),
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) => downloadExport(tx, ctx, requested.id)),
      ConflictError,
    );
    expect(await processExport(handle.db, organization.id, requested.id)).toBe('completed');
    const file = await inOrg(organization, owner.id, (tx, ctx) =>
      downloadExport(tx, ctx, requested.id),
    );
    expect(file.fileName).toMatch(/^contacts-\d{12}\.csv$/);
    expect(file.content).toContain(`'=HYPERLINK(""http://evil"")`);
    expect(file.content).not.toContain('Inactive');
    expect(file.summary).toMatchObject({ rowCount: 1, downloadCount: 1 });
    await expectError(
      inOrg(organization, other.id, (tx, ctx) => downloadExport(tx, ctx, requested.id)),
      NotFoundError,
    );
    await expectError(
      inOrg(B(), bOwner(), (tx, ctx) => downloadExport(tx, ctx, requested.id)),
      NotFoundError,
    );
    await expectError(
      inOrg(organization, owner.id, (tx, ctx) =>
        requestExport(tx, ctx, { entityType: 'contact', filters: { status: 'bogus' } }),
      ),
      Error,
    );
  });
});
