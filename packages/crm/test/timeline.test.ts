import { projectEvent } from '@businessos/activities';
import {
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { NotFoundError, ValidationError } from '@businessos/shared';
import { createTestDatabase, createTestWorld, type TestWorld } from '@businessos/testing';
import { and, asc, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompany,
  createContact,
  createDeal,
  createNote,
  createTask,
  crmTimelineProjectors,
  listPipelines,
  logActivity,
  moveDeal,
  recordTimeline,
  updateContact,
  updateTask,
  type CrmContext,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const ALL = new Set(['crm.contact.read', 'crm.company.read', 'crm.deal.read', 'crm.task.read']);

function ctxFor(org: Organization, userId: string | null): CrmContext {
  return {
    organizationId: org.id,
    countryCode: org.countryCode,
    defaultCurrency: org.defaultCurrency,
    timezone: org.timezone,
    actor: { type: 'user', userId },
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

/** Delivers every outbox event of the organization emitted after `since` to the projectors. */
async function project(organizationId: string, since: Date): Promise<number> {
  // System scope: test plays the worker, which reads the outbox across tenants.
  const rows = await withSystem(handle.db, (tx) =>
    tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.organizationId, organizationId), gt(outboxEvents.occurredAt, since)),
      )
      .orderBy(asc(outboxEvents.id)),
  );
  let projected = 0;
  for (const row of rows) {
    const event = await loadEvent(handle.db, row.id);
    if (event && (await projectEvent(handle.db, crmTimelineProjectors, event))) projected += 1;
  }
  return projected;
}

const A = () => world.orgA.organization;
const owner = () => world.orgA.users.owner.id;

describe('CRM timeline projection', () => {
  it('builds a contact timeline from CRM events, idempotently, with snapshots', async () => {
    const since = new Date(Date.now() - 1_000);
    const { contact, deal, task, won } = await inOrg(A(), owner(), async (tx, ctx) => {
      const company = await createCompany(tx, ctx, { name: 'Gulf Steel Timeline' });
      const contact = await createContact(tx, ctx, { firstName: 'Huda', companyId: company.id });
      await updateContact(tx, ctx, contact.id, { jobTitle: 'Buyer' });
      await createNote(
        tx,
        ctx,
        { type: 'contact', id: contact.id },
        { body: 'Asked for\n\nrebar prices' },
      );
      const task = await createTask(tx, ctx, { title: 'Send rebar quote', contactId: contact.id });
      await updateTask(tx, ctx, task.id, { status: 'completed' });
      const pipeline = (await listPipelines(tx, ctx.organizationId))[0];
      const won = pipeline?.stages.find((stage) => stage.kind === 'won');
      if (!pipeline || !won) throw new Error('pipeline');
      const deal = await createDeal(tx, ctx, {
        name: 'Rebar 2026',
        contactId: contact.id,
        value: { amount: '12500.250', currency: 'BHD' },
      });
      return { contact, deal, task, won };
    });
    await inOrg(A(), owner(), (tx, ctx) => moveDeal(tx, ctx, deal.id, { stageId: won.id }));
    const projected = await project(A().id, since);
    expect(projected).toBeGreaterThanOrEqual(8);
    // Redelivery projects nothing new.
    expect(await project(A().id, since)).toBe(0);

    const timeline = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(tx, ctx, 'contact', contact.id, { limit: 50 }, ALL),
    );
    const types = timeline.data.map((row) => row.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'contact.created',
        'contact.updated',
        'note.created',
        'task.created',
        'task.completed',
        'deal.created',
        'deal.stage_changed',
        'deal.won',
      ]),
    );
    const byType = Object.fromEntries(timeline.data.map((row) => [row.type, row]));
    expect(byType['note.created']?.summary).toBe('Asked for rebar prices');
    expect(byType['contact.updated']?.summary).toBe('Contact updated: job title');
    expect(byType['task.completed']?.summary).toBe(`Task completed: ${task.title}`);
    expect(byType['deal.won']?.summary).toBe('Deal won: Rebar 2026 · BHD 12500.250');
    expect(byType['deal.won']?.metadata).toEqual({
      dealName: 'Rebar 2026',
      value: { amount: '12500.250', currency: 'BHD' },
    });
    expect(byType['deal.stage_changed']?.summary).toBe('Rebar 2026 moved from Lead to Won');
    expect(byType['contact.created']?.actor).toEqual({
      type: 'user',
      userId: owner(),
      name: world.orgA.users.owner.name,
    });
    // Newest first.
    const times = timeline.data.map((row) => row.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);

    // Without deal access, deal activities disappear from the contact timeline.
    const noDeals = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(
        tx,
        ctx,
        'contact',
        contact.id,
        { limit: 50 },
        new Set(['crm.contact.read', 'crm.task.read']),
      ),
    );
    expect(noDeals.data.some((row) => row.category === 'deal')).toBe(false);
    expect(noDeals.data.some((row) => row.type === 'note.created')).toBe(true);

    // The deal and company timelines see the same history from their side.
    const dealTimeline = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(tx, ctx, 'deal', deal.id, { limit: 50 }, ALL),
    );
    expect(dealTimeline.data.map((row) => row.type)).toEqual([
      'deal.won',
      'deal.stage_changed',
      'deal.created',
    ]);
    const companyId = contact.primaryCompany?.id;
    if (!companyId) throw new Error('company');
    const companyTimeline = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(tx, ctx, 'company', companyId, { limit: 50, category: 'note' }, ALL),
    );
    expect(companyTimeline.data.map((row) => row.type)).toEqual(['note.created']);
  });

  it('requires deal access for notes written on deals, even on the contact timeline', async () => {
    const since = new Date(Date.now() - 1_000);
    const { contact } = await inOrg(A(), owner(), async (tx, ctx) => {
      const contact = await createContact(tx, ctx, { firstName: 'Deal note' });
      const deal = await createDeal(tx, ctx, { name: 'Confidential deal', contactId: contact.id });
      await createNote(tx, ctx, { type: 'deal', id: deal.id }, { body: 'Discount up to 15%' });
      return { contact };
    });
    await project(A().id, since);
    const contactOnly = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(tx, ctx, 'contact', contact.id, { limit: 50 }, new Set(['crm.contact.read'])),
    );
    expect(contactOnly.data.map((row) => row.summary)).not.toContain('Discount up to 15%');
    const withDeals = await inOrg(A(), owner(), (tx, ctx) =>
      recordTimeline(tx, ctx, 'contact', contact.id, { limit: 50 }, ALL),
    );
    expect(withDeals.data.map((row) => row.summary)).toContain('Discount up to 15%');
  });

  it('logs calls with graph-completed links and keeps timelines tenant isolated', async () => {
    const result = await inOrg(A(), owner(), async (tx, ctx) => {
      const company = await createCompany(tx, ctx, { name: 'Logged Co' });
      const contact = await createContact(tx, ctx, { firstName: 'Caller', companyId: company.id });
      const deal = await createDeal(tx, ctx, {
        name: 'Call deal',
        contactId: contact.id,
        companyId: company.id,
      });
      const call = await logActivity(tx, ctx, {
        type: 'call.logged',
        summary: 'Discussed delivery schedule',
        details: 'Prefers Sunday deliveries',
        direction: 'outbound',
        durationMinutes: 12,
        dealId: deal.id,
      });
      return { company, contact, deal, call };
    });
    expect(result.call).toMatchObject({
      type: 'call.logged',
      channel: 'phone',
      dealId: result.deal.id,
      contactId: result.contact.id,
      companyId: result.company.id,
      manual: true,
      metadata: {
        details: 'Prefers Sunday deliveries',
        direction: 'outbound',
        durationMinutes: 12,
      },
    });
    await expect(
      inOrg(A(), owner(), (tx, ctx) =>
        logActivity(tx, ctx, {
          type: 'call.logged',
          summary: 'Future',
          contactId: result.contact.id,
          occurredAt: '2999-01-01T00:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const B = world.orgB.organization;
    await expect(
      inOrg(B, world.orgB.users.owner.id, (tx, ctx) =>
        logActivity(tx, ctx, {
          type: 'call.logged',
          summary: 'Probe',
          contactId: result.contact.id,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inOrg(B, world.orgB.users.owner.id, (tx, ctx) =>
        recordTimeline(tx, ctx, 'contact', result.contact.id, { limit: 10 }, ALL),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
