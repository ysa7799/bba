import { projectEvent } from '@businessos/activities';
import { crmTimelineProjectors } from '@businessos/crm';
import { outboxEvents, withSystem } from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

const crm = (orgId: string, path: string) => `/app/orgs/${orgId}/crm${path}`;

/** Plays the worker: projects every outbox event of the organization (idempotent). */
async function projectAll(organizationId: string): Promise<void> {
  // System scope: the test stands in for the worker's outbox delivery.
  const rows = await withSystem(ctx.db.db, (tx) =>
    tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.organizationId, organizationId)))
      .orderBy(asc(outboxEvents.id)),
  );
  for (const row of rows) {
    const event = await loadEvent(ctx.db.db, row.id);
    if (event) await projectEvent(ctx.db.db, crmTimelineProjectors, event);
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

describe('activity timeline API', () => {
  it('shows projected activities on the contact timeline with permission gating', async () => {
    const owner = await as(world.orgA.users.owner);
    const contact = (
      await owner.post(crm(A, '/contacts'), { firstName: `Timeline ${uniqueSuffix()}` })
    ).json().contact;
    await owner.post(crm(A, `/contacts/${contact.id}/notes`), { body: 'Prefers WhatsApp' });
    const deal = (
      await owner.post(crm(A, '/deals'), { name: 'Timeline deal', contactId: contact.id })
    ).json().deal;
    await projectAll(A);

    const timeline = await owner.get(crm(A, `/contacts/${contact.id}/timeline`));
    expect(timeline.statusCode).toBe(200);
    const types = timeline.json().data.map((row: { type: string }) => row.type);
    expect(types).toEqual(
      expect.arrayContaining(['contact.created', 'note.created', 'deal.created']),
    );

    const restricted = await as(world.orgA.users.restricted);
    expect((await restricted.get(crm(A, `/contacts/${contact.id}/timeline`))).statusCode).toBe(200);
    expect((await restricted.get(crm(A, `/deals/${deal.id}/timeline`))).json().data[0].type).toBe(
      'deal.created',
    );
    expect(
      (await restricted.get(crm(A, `/contacts/${contact.id}/timeline?category=bogus`))).statusCode,
    ).toBe(400);

    const notesOnly = await owner.get(crm(A, `/contacts/${contact.id}/timeline?category=note`));
    expect(notesOnly.json().data.map((row: { summary: string }) => row.summary)).toEqual([
      'Prefers WhatsApp',
    ]);
  });

  it('logs and deletes activities with authorship rules and audit', async () => {
    const owner = await as(world.orgA.users.owner);
    const sales = await as(world.orgA.users.sales);
    const manager = await as(world.orgA.users.manager);
    const restricted = await as(world.orgA.users.restricted);
    const contact = (await owner.post(crm(A, '/contacts'), { firstName: 'Logged' })).json().contact;

    expect(
      (
        await restricted.post(crm(A, '/activities'), {
          type: 'call.logged',
          summary: 'x',
          contactId: contact.id,
        })
      ).statusCode,
    ).toBe(403);
    const invalid = await sales.post(crm(A, '/activities'), {
      type: 'contact.created',
      summary: 'forged',
      contactId: contact.id,
    });
    expect(invalid.statusCode).toBe(400);
    const noLink = await sales.post(crm(A, '/activities'), {
      type: 'call.logged',
      summary: 'no link',
    });
    expect(noLink.statusCode).toBe(400);

    const logged = await sales.post(crm(A, '/activities'), {
      type: 'whatsapp.logged',
      summary: 'Sent the price list',
      direction: 'outbound',
      contactId: contact.id,
      // Server-controlled fields are ignored.
      requiredPermission: 'audit.read',
      actorUserId: world.orgA.users.owner.id,
      sourceEventId: '01a10a7d-64ba-7000-a694-68839952f9b9',
    });
    expect(logged.statusCode).toBe(201);
    const activity = logged.json().activity;
    expect(activity).toMatchObject({
      channel: 'whatsapp',
      manual: true,
      actor: { userId: world.orgA.users.sales.id },
    });
    const listed = (await restricted.get(crm(A, `/contacts/${contact.id}/timeline`))).json().data;
    expect(listed.map((row: { id: string }) => row.id)).toContain(activity.id);

    // Another member cannot delete it; a moderator can.
    expect((await restricted.delete(crm(A, `/activities/${activity.id}`))).statusCode).toBe(403);
    const second = (
      await sales.post(crm(A, '/activities'), {
        type: 'call.logged',
        summary: 'Second',
        contactId: contact.id,
      })
    ).json().activity;
    expect((await sales.delete(crm(A, `/activities/${second.id}`))).statusCode).toBe(204);
    expect((await manager.delete(crm(A, `/activities/${activity.id}`))).statusCode).toBe(204);
    const audit = (await owner.get(`/app/orgs/${A}/audit-logs?action=crm.activity.deleted`)).json()
      .data;
    expect(audit.map((row: { targetId: string }) => row.targetId)).toEqual(
      expect.arrayContaining([activity.id, second.id]),
    );

    // Projected history cannot be deleted.
    await projectAll(A);
    const created = (await owner.get(crm(A, `/contacts/${contact.id}/timeline`)))
      .json()
      .data.find((row: { type: string }) => row.type === 'contact.created');
    expect((await owner.delete(crm(A, `/activities/${created.id}`))).statusCode).toBe(403);
  });

  it('never exposes another tenant’s timeline or activities', async () => {
    const owner = await as(world.orgA.users.owner);
    const contact = (await owner.post(crm(A, '/contacts'), { firstName: 'Isolated' })).json()
      .contact;
    const call = (
      await owner.post(crm(A, '/activities'), {
        type: 'call.logged',
        summary: 'Secret',
        contactId: contact.id,
      })
    ).json().activity;
    const bAdmin = await as(world.orgB.users.admin);
    expect((await bAdmin.get(crm(B, `/contacts/${contact.id}/timeline`))).statusCode).toBe(404);
    expect((await bAdmin.get(crm(A, `/contacts/${contact.id}/timeline`))).statusCode).toBe(404);
    expect((await bAdmin.delete(crm(B, `/activities/${call.id}`))).statusCode).toBe(404);
    expect(
      (
        await bAdmin.post(crm(B, '/activities'), {
          type: 'call.logged',
          summary: 'x',
          contactId: contact.id,
        })
      ).statusCode,
    ).toBe(400);
    const feed = JSON.stringify((await bAdmin.get(crm(B, '/activities'))).json());
    expect(feed).not.toContain(call.id);
    expect(feed).not.toContain('Secret');
  });
});
