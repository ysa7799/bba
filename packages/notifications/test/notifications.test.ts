import { createTask, type CrmContext } from '@businessos/crm';
import {
  commerceInvoices,
  memberships,
  notifications,
  outboxEvents,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import { loadEvent, type DomainEvent } from '@businessos/events';
import type { Permission } from '@businessos/permissions';
import { newId, NotFoundError, ValidationError } from '@businessos/shared';
import {
  addTestMember,
  createTestDatabase,
  createTestUser,
  createTestWorld,
  type TestWorld,
} from '@businessos/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  countUnread,
  deliverNotifications,
  getPreferences,
  listNotifications,
  markAllRead,
  markRead,
  pruneNotifications,
  updatePreferences,
  type NotificationServices,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
let emails: { to: string; data: Record<string, string | null>; jobId: string }[] = [];
let services: NotificationServices;

beforeAll(async () => {
  handle = createTestDatabase(8);
  world = await createTestWorld(handle.db);
  services = {
    db: handle.db,
    appUrl: 'https://app.example.com',
    enqueueEmail: (payload, jobId) => {
      emails.push({ ...payload, jobId });
      return Promise.resolve();
    },
  };
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  emails = [];
});

const A = () => world.orgA.organization;
const owner = () => world.orgA.users.owner;
const sales = () => world.orgA.users.sales;
const restricted = () => world.orgA.users.restricted;

function ctx(userId: string): CrmContext {
  return {
    organizationId: A().id,
    countryCode: A().countryCode,
    defaultCurrency: A().defaultCurrency,
    timezone: A().timezone,
    actor: { type: 'user', userId },
  };
}

const scope = (userId: string) => ({ organizationId: A().id, userId });

async function assignTask(byUserId: string, assigneeUserId: string, title = 'Call back Fatima') {
  const task = await withTenant(handle.db, scope(byUserId), (tx) =>
    createTask(tx, ctx(byUserId), { title, assigneeUserId }),
  );
  const [row] = await withSystem(handle.db, (tx) =>
    tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, 'task.created'), eq(outboxEvents.subjectId, task.id))),
  );
  const event = row ? await loadEvent(handle.db, row.id) : null;
  if (!event) throw new Error('task.created was not emitted');
  return { task, event };
}

function mine(userId: string) {
  return withTenant(handle.db, scope(userId), (tx) => listNotifications(tx, scope(userId), {}));
}

describe('delivery', () => {
  it('notifies the assignee in-app and by email, once per event', async () => {
    const { event } = await assignTask(owner().id, sales().id);
    const first = await deliverNotifications(services, event);
    const again = await deliverNotifications(services, event);
    expect(first).toEqual({ delivered: 1, emailed: 1 });
    expect(again.delivered).toBe(0);
    const list = await mine(sales().id);
    const notification = list.data.find((entry) => entry.title.endsWith('Call back Fatima'));
    expect(notification).toMatchObject({
      type: 'task.assigned',
      title: 'Task assigned to you: Call back Fatima',
      link: `/o/${A().id}/crm/tasks`,
      readAt: null,
    });
    // Redelivered emails reuse the job id, so the queue sends one.
    expect(emails).toHaveLength(2);
    expect(emails[0]?.jobId).toBe(emails[1]?.jobId);
    expect(emails[0]).toMatchObject({
      to: sales().email,
      data: { link: `https://app.example.com/o/${A().id}/crm/tasks` },
    });
  });

  it('does not notify people about their own actions', async () => {
    const { event } = await assignTask(sales().id, sales().id, 'My own task');
    expect(await deliverNotifications(services, event)).toEqual({ delivered: 0, emailed: 0 });
  });

  it('re-checks membership and permission at delivery', async () => {
    // Restricted members cannot read invoices: no notification about one.
    const invoiceId = newId();
    const event: DomainEvent = {
      id: newId(),
      type: 'invoice.paid',
      version: 1,
      organizationId: A().id,
      occurredAt: new Date(),
      actor: { type: 'system', id: null },
      subject: { type: 'invoice', id: invoiceId },
      correlationId: null,
      causationId: null,
      payload: { invoiceId, contactId: newId(), totalMinor: '1000', currency: 'BHD' },
    };
    // No such invoice: nothing to word, nothing delivered.
    expect(await deliverNotifications(services, event)).toEqual({ delivered: 0, emailed: 0 });

    // A suspended member gets nothing, even for a task assigned to them.
    const suspended = await createTestUser(handle.db, { name: 'Away' });
    await addTestMember(handle.db, A().id, suspended.id);
    const { event: assigned } = await assignTask(owner().id, suspended.id, 'While away');
    await withSystem(handle.db, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.userId, suspended.id), eq(memberships.organizationId, A().id))),
    );
    expect(await deliverNotifications(services, assigned)).toEqual({ delivered: 0, emailed: 0 });
  });

  it('withholds notifications the recipient may not read', async () => {
    const restrictedUser = restricted();
    // An invoice created by a member who cannot read invoices.
    const contact = await withSystem(handle.db, async (tx) => {
      const { crmContacts } = await import('@businessos/database');
      const [row] = await tx
        .insert(crmContacts)
        .values({ organizationId: A().id, firstName: 'Noor' })
        .returning();
      return row;
    });
    const invoiceId = newId();
    await withSystem(handle.db, (tx) =>
      tx.insert(commerceInvoices).values({
        id: invoiceId,
        organizationId: A().id,
        contactId: contact?.id ?? '',
        currency: 'BHD',
        number: `INV-T${Date.now()}`,
        status: 'paid',
        issueDate: '2026-03-01',
        createdByUserId: restrictedUser.id,
      }),
    );
    const event: DomainEvent = {
      id: newId(),
      type: 'invoice.paid',
      version: 1,
      organizationId: A().id,
      occurredAt: new Date(),
      actor: { type: 'system', id: null },
      subject: { type: 'invoice', id: invoiceId },
      correlationId: null,
      causationId: null,
      payload: { invoiceId, contactId: contact?.id ?? '', totalMinor: '0', currency: 'BHD' },
    };
    expect(await deliverNotifications(services, event)).toEqual({ delivered: 0, emailed: 0 });
    // The same invoice created by a member who may read invoices is delivered.
    await withSystem(handle.db, (tx) =>
      tx
        .update(commerceInvoices)
        .set({ createdByUserId: sales().id })
        .where(eq(commerceInvoices.id, invoiceId)),
    );
    expect((await deliverNotifications(services, event)).delivered).toBe(1);
  });

  it('follows each member’s channel choices', async () => {
    const permissions = new Set<Permission>(['crm.task.read']);
    await withTenant(handle.db, scope(sales().id), (tx) =>
      updatePreferences(tx, scope(sales().id), permissions, {
        preferences: [{ type: 'task.assigned', inApp: true, email: false }],
      }),
    );
    const { event } = await assignTask(owner().id, sales().id, 'No email please');
    expect(await deliverNotifications(services, event)).toEqual({ delivered: 1, emailed: 0 });
    await withTenant(handle.db, scope(sales().id), (tx) =>
      updatePreferences(tx, scope(sales().id), permissions, {
        preferences: [{ type: 'task.assigned', inApp: false, email: false }],
      }),
    );
    const { event: silent } = await assignTask(owner().id, sales().id, 'Silent');
    expect(await deliverNotifications(services, silent)).toEqual({ delivered: 0, emailed: 0 });
    await withTenant(handle.db, scope(sales().id), (tx) =>
      updatePreferences(tx, scope(sales().id), permissions, {
        preferences: [{ type: 'task.assigned', inApp: true, email: true }],
      }),
    );
  });
});

describe('member inbox', () => {
  it('lists, counts and marks only the member’s own notifications', async () => {
    const { event } = await assignTask(owner().id, sales().id, 'Prepare quote');
    await deliverNotifications(services, event);
    const before = await mine(sales().id);
    expect(before.unread).toBeGreaterThanOrEqual(1);
    const target = before.data.find((entry) => entry.title.endsWith('Prepare quote'));
    if (!target) throw new Error('missing notification');

    // Another member of the same organization cannot see or change it (RLS and filters).
    const theirs = await mine(owner().id);
    expect(theirs.data.some((entry) => entry.id === target.id)).toBe(false);
    await expect(
      withTenant(handle.db, scope(owner().id), (tx) => markRead(tx, scope(owner().id), target.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
    const visible = await withTenant(handle.db, scope(owner().id), (tx) =>
      tx.select().from(notifications).where(eq(notifications.id, target.id)),
    );
    expect(visible).toEqual([]);
    // Nor can another organization.
    const outsider = world.orgB.users.owner.id;
    const elsewhere = await withTenant(
      handle.db,
      { organizationId: world.orgB.organization.id, userId: outsider },
      (tx) => tx.select().from(notifications).where(eq(notifications.id, target.id)),
    );
    expect(elsewhere).toEqual([]);

    const read = await withTenant(handle.db, scope(sales().id), (tx) =>
      markRead(tx, scope(sales().id), target.id),
    );
    expect(read.readAt).not.toBeNull();
    await withTenant(handle.db, scope(sales().id), (tx) => markAllRead(tx, scope(sales().id)));
    expect(
      await withTenant(handle.db, scope(sales().id), (tx) => countUnread(tx, scope(sales().id))),
    ).toBe(0);
    const unreadOnly = await withTenant(handle.db, scope(sales().id), (tx) =>
      listNotifications(tx, scope(sales().id), { unread: 'true' }),
    );
    expect(unreadOnly.data).toEqual([]);
  });

  it('offers preferences only for types the member can receive', async () => {
    const memberPermissions = new Set<Permission>(['crm.task.read', 'crm.deal.read']);
    const preferences = await withTenant(handle.db, scope(sales().id), (tx) =>
      getPreferences(tx, scope(sales().id), memberPermissions),
    );
    expect(preferences.map((entry) => entry.type)).toEqual(['task.assigned', 'deal.won']);
    await expect(
      withTenant(handle.db, scope(sales().id), (tx) =>
        updatePreferences(tx, scope(sales().id), memberPermissions, {
          preferences: [{ type: 'invoice.paid', inApp: false, email: false }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('retention', () => {
  it('removes read notifications after 90 days and any after a year', async () => {
    const day = 86_400_000;
    const now = new Date();
    const seed = (title: string, ageDays: number, read: boolean) => ({
      organizationId: A().id,
      userId: sales().id,
      type: 'task.assigned',
      title,
      subjectType: 'task',
      subjectId: newId(),
      sourceEventId: newId(),
      createdAt: new Date(now.getTime() - ageDays * day),
      readAt: read ? new Date(now.getTime() - ageDays * day) : null,
    });
    const rows = await withSystem(handle.db, (tx) =>
      tx
        .insert(notifications)
        .values([
          seed('old read', 91, true),
          seed('old unread', 91, false),
          seed('ancient unread', 366, false),
          seed('recent read', 10, true),
        ])
        .returning({ id: notifications.id, title: notifications.title }),
    );
    expect(await pruneNotifications(handle.db, now)).toBeGreaterThanOrEqual(2);
    const left = await withSystem(handle.db, (tx) =>
      tx
        .select({ title: notifications.title })
        .from(notifications)
        .where(
          inArray(
            notifications.id,
            rows.map((row) => row.id),
          ),
        ),
    );
    expect(left.map((row) => row.title).sort()).toEqual(['old unread', 'recent read']);
  });
});
