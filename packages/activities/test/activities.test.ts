import {
  activities,
  crmContacts,
  withTenant,
  type DatabaseHandle,
  type TenantTx,
} from '@businessos/database';
import { ForbiddenError, newId, NotFoundError, ValidationError } from '@businessos/shared';
import { createTestDatabase, createTestWorld, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  deleteLoggedActivity,
  listActivities,
  MANUAL_ACTIVITY_TYPES,
  recordActivity,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;

beforeAll(async () => {
  handle = createTestDatabase(4);
  world = await createTestWorld(handle.db);
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization.id;
const B = () => world.orgB.organization.id;
const inA = <T>(fn: (tx: TenantTx) => Promise<T>) =>
  withTenant(handle.db, { organizationId: A(), userId: null }, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>) =>
  withTenant(handle.db, { organizationId: B(), userId: null }, fn);

async function contactIn(organization: 'A' | 'B'): Promise<string> {
  const id = newId();
  const run = organization === 'A' ? inA : inB;
  await run((tx) =>
    tx
      .insert(crmContacts)
      .values({ id, organizationId: organization === 'A' ? A() : B(), firstName: 'Timeline' }),
  );
  return id;
}

const all = new Set(['crm.contact.read', 'crm.company.read', 'crm.deal.read', 'crm.task.read']);

describe('activity registry', () => {
  it('declares metadata keys and permissions for every type', () => {
    for (const [type, definition] of Object.entries(ACTIVITY_TYPES)) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(definition.permission).toMatch(/^(crm|communications|calendar|forms)\./);
      expect(Array.isArray(definition.metadataKeys)).toBe(true);
    }
    expect(MANUAL_ACTIVITY_TYPES).toEqual([
      'call.logged',
      'meeting.logged',
      'email.logged',
      'whatsapp.logged',
      'sms.logged',
    ]);
  });
});

describe('recording and reading activities', () => {
  it('projects exactly once per source event', async () => {
    const contactId = await contactIn('A');
    const sourceEventId = newId();
    const input = {
      organizationId: A(),
      type: 'contact.created' as const,
      actor: { type: 'system' as const, userId: null },
      subject: { type: 'contact', id: contactId },
      contactId,
      summary: 'Contact created',
      sourceEventId,
    };
    const first = await inA((tx) => recordActivity(tx, input));
    const again = await inA((tx) => recordActivity(tx, input));
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    const rows = await inA((tx) =>
      tx.select().from(activities).where(eq(activities.sourceEventId, sourceEventId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('requires a record link and collapses long summaries', async () => {
    await expect(
      inA((tx) =>
        recordActivity(tx, {
          organizationId: A(),
          type: 'contact.created',
          actor: { type: 'system', userId: null },
          subject: { type: 'contact', id: newId() },
          summary: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const contactId = await contactIn('A');
    const row = await inA((tx) =>
      recordActivity(tx, {
        organizationId: A(),
        type: 'note.created',
        actor: { type: 'system', userId: null },
        subject: { type: 'note', id: newId() },
        contactId,
        summary: `line one\n\nline two ${'x'.repeat(2_000)}`,
      }),
    );
    expect(row?.summary.startsWith('line one line two')).toBe(true);
    expect(row?.summary.length).toBe(1_000);
  });

  it('gates rows by their required permission and exposes only declared metadata', async () => {
    const contactId = await contactIn('A');
    await inA(async (tx) => {
      await recordActivity(tx, {
        organizationId: A(),
        type: 'deal.won',
        actor: { type: 'system', userId: null },
        subject: { type: 'deal', id: newId() },
        contactId,
        summary: 'Deal won',
        metadata: {
          dealName: 'Big',
          value: { amount: '1.000', currency: 'BHD' },
          internalScore: 99,
          password: 'x',
        },
      });
      await recordActivity(tx, {
        organizationId: A(),
        type: 'note.created',
        actor: { type: 'system', userId: null },
        subject: { type: 'note', id: newId() },
        contactId,
        summary: 'Note',
      });
    });
    const full = await inA((tx) =>
      listActivities(tx, A(), { kind: 'contact', id: contactId }, { limit: 10 }, all),
    );
    expect(full.data.map((row) => row.type).sort()).toEqual(['deal.won', 'note.created']);
    const won = full.data.find((row) => row.type === 'deal.won');
    expect(won?.metadata).toEqual({ dealName: 'Big', value: { amount: '1.000', currency: 'BHD' } });
    const contactOnly = await inA((tx) =>
      listActivities(
        tx,
        A(),
        { kind: 'contact', id: contactId },
        { limit: 10 },
        new Set(['crm.contact.read']),
      ),
    );
    expect(contactOnly.data.map((row) => row.type)).toEqual(['note.created']);
    const nothing = await inA((tx) =>
      listActivities(tx, A(), { kind: 'contact', id: contactId }, { limit: 10 }, new Set()),
    );
    expect(nothing.data).toEqual([]);
    const notes = await inA((tx) =>
      listActivities(
        tx,
        A(),
        { kind: 'contact', id: contactId },
        { limit: 10, category: 'note' },
        all,
      ),
    );
    expect(notes.data.map((row) => row.type)).toEqual(['note.created']);
  });

  it('paginates newest first without gaps or repeats', async () => {
    const contactId = await contactIn('A');
    await inA(async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await recordActivity(tx, {
          organizationId: A(),
          type: 'call.logged',
          occurredAt: new Date(Date.UTC(2026, 0, 1 + (i % 3))),
          actor: { type: 'system', userId: null },
          subject: { type: 'activity', id: contactId },
          contactId,
          summary: `Call ${i}`,
        });
      }
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await inA((tx) =>
        listActivities(tx, A(), { kind: 'contact', id: contactId }, { limit: 3, cursor }, all),
      );
      seen.push(...page.data.map((row) => row.summary));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(0, 2).every((summary) => ['Call 2', 'Call 5'].includes(summary))).toBe(true);
  });

  it('is tenant isolated (RLS) and links cannot point at another tenant', async () => {
    const contactA = await contactIn('A');
    await inA((tx) =>
      recordActivity(tx, {
        organizationId: A(),
        type: 'call.logged',
        actor: { type: 'system', userId: null },
        subject: { type: 'activity', id: contactA },
        contactId: contactA,
        summary: 'Secret call',
      }),
    );
    const fromB = await inB((tx) =>
      listActivities(tx, B(), { kind: 'contact', id: contactA }, { limit: 10 }, all),
    );
    expect(fromB.data).toEqual([]);
    const raw = await inB((tx) =>
      tx.select().from(activities).where(eq(activities.contactId, contactA)),
    );
    expect(raw).toEqual([]);
    await expect(
      inB((tx) =>
        recordActivity(tx, {
          organizationId: B(),
          type: 'call.logged',
          actor: { type: 'system', userId: null },
          subject: { type: 'activity', id: contactA },
          contactId: contactA,
          summary: 'Cross-tenant link',
        }),
      ),
    ).rejects.toThrow();
  });

  it('deletes only logged activities, by their author or a moderator', async () => {
    const contactId = await contactIn('A');
    const author = world.orgA.users.sales.id;
    const other = world.orgA.users.manager.id;
    const [logged, projected] = await inA(async (tx) => [
      await recordActivity(tx, {
        organizationId: A(),
        type: 'call.logged',
        actor: { type: 'user', userId: author },
        subject: { type: 'activity', id: contactId },
        contactId,
        summary: 'Call',
      }),
      await recordActivity(tx, {
        organizationId: A(),
        type: 'contact.created',
        actor: { type: 'user', userId: author },
        subject: { type: 'contact', id: contactId },
        contactId,
        summary: 'Created',
        sourceEventId: newId(),
      }),
    ]);
    if (!logged || !projected) throw new Error('fixture');
    const access = (userId: string, canModerate: boolean, permissions = all) => ({
      userId,
      permissions,
      canModerate,
    });
    await expect(
      inA((tx) => deleteLoggedActivity(tx, A(), projected.id, access(author, true))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inA((tx) => deleteLoggedActivity(tx, A(), logged.id, access(other, false))),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      inA((tx) =>
        deleteLoggedActivity(tx, A(), logged.id, access(author, false, new Set(['crm.deal.read']))),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      inB((tx) => deleteLoggedActivity(tx, B(), logged.id, access(author, true))),
    ).rejects.toBeInstanceOf(NotFoundError);
    await inA((tx) => deleteLoggedActivity(tx, A(), logged.id, access(author, false)));
    await expect(
      inA((tx) => deleteLoggedActivity(tx, A(), logged.id, access(author, false))),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
