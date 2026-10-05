import { tokenFromLink } from '@businessos/auth';
import { auditLogs, outboxEvents, withSystem, withTenant } from '@businessos/database';
import { createTestWorld, systemRoleId, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, TEST_PASSWORD, TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

describe('audit log', () => {
  it('records administrative actions with actor, target, request id and client IP', async () => {
    const admin = await loginAs(ctx, world.orgA.users.admin);
    const target = await withSystem(ctx.db.db, async (tx) => {
      const { memberships } = await import('@businessos/database');
      const [row] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.organizationId, A), eq(memberships.userId, world.orgA.users.sales.id)),
        );
      return row!.id;
    });
    const managerRole = await systemRoleId(ctx.db.db, A, 'manager');
    const response = await admin.request('PUT', `/app/orgs/${A}/members/${target}/roles`, {
      roleIds: [managerRole],
    });
    expect(response.statusCode).toBe(200);

    const page = await admin.get(`/app/orgs/${A}/audit-logs?action=member.roles_changed`);
    expect(page.statusCode).toBe(200);
    const entry = (page.json().data as Record<string, unknown>[])[0];
    expect(entry).toMatchObject({
      action: 'member.roles_changed',
      actorType: 'user',
      actorUserId: world.orgA.users.admin.id,
      actorLabel: world.orgA.users.admin.email,
      targetType: 'membership',
      targetId: target,
      requestId: response.headers['x-request-id'],
      ipAddress: '127.0.0.1',
      metadata: { before: ['Member'], after: ['Manager'] },
    });
  });

  it('requires audit.read and is tenant isolated', async () => {
    const restricted = await loginAs(ctx, world.orgA.users.restricted);
    expect((await restricted.get(`/app/orgs/${A}/audit-logs`)).statusCode).toBe(403);
    const outsider = await loginAs(ctx, world.orgB.users.owner);
    expect((await outsider.get(`/app/orgs/${A}/audit-logs`)).statusCode).toBe(404);
    const bOwnLogs = await outsider.get(
      `/app/orgs/${world.orgB.organization.id}/audit-logs?limit=100`,
    );
    expect(bOwnLogs.statusCode).toBe(200);
    for (const entry of bOwnLogs.json().data as { actorUserId: string | null }[]) {
      expect(entry.actorUserId).not.toBe(world.orgA.users.admin.id);
    }
  });

  it('paginates newest first and validates filters', async () => {
    const owner = await loginAs(ctx, world.orgA.users.owner);
    for (const locale of ['ar', 'en', 'ar']) {
      await owner.patch(`/app/orgs/${A}`, { locale });
    }
    const first = await owner.get(`/app/orgs/${A}/audit-logs?action=organization.updated&limit=2`);
    expect(first.json().data).toHaveLength(2);
    const cursor = first.json().nextCursor as string;
    const second = await owner.get(
      `/app/orgs/${A}/audit-logs?action=organization.updated&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    const ids = [...first.json().data, ...second.json().data].map((e: { id: string }) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = [...first.json().data, ...second.json().data].map((e: { createdAt: string }) =>
      Date.parse(e.createdAt),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await owner.get(`/app/orgs/${A}/audit-logs?action=drop.table`)).statusCode).toBe(400);
    expect((await owner.get(`/app/orgs/${A}/audit-logs?cursor=garbage`)).statusCode).toBe(400);
  });

  it('is append-only: tenant code cannot update or delete audit records', async () => {
    const updated = await withTenant(ctx.db.db, { organizationId: A, userId: null }, (tx) =>
      tx
        .update(auditLogs)
        .set({ action: 'organization.created' })
        .where(eq(auditLogs.organizationId, A))
        .returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await withTenant(ctx.db.db, { organizationId: A, userId: null }, (tx) =>
      tx.delete(auditLogs).where(eq(auditLogs.organizationId, A)).returning(),
    );
    expect(deleted).toEqual([]);
    const systemDelete = await withSystem(ctx.db.db, (tx) =>
      tx.delete(auditLogs).where(eq(auditLogs.organizationId, A)).returning(),
    );
    expect(systemDelete).toEqual([]);
  });

  it('records account security events without secrets', async () => {
    const email = `audited.${uniqueSuffix()}@example.com`;
    const client = new TestClient(ctx.app);
    await client.post('/app/auth/register', { name: 'Audited', email, password: TEST_PASSWORD });
    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'verify_email') throw new Error('no email');
    const token = tokenFromLink(sent.link);
    await client.post('/app/auth/verify-email', { token });
    await client.post('/app/auth/login', { email, password: 'wrong password here' });
    await client.post('/app/auth/login', { email, password: TEST_PASSWORD });
    await client.post('/app/auth/logout');

    const rows = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(auditLogs).where(eq(auditLogs.actorLabel, email)),
    );
    expect(rows.map((row) => row.action).sort()).toEqual(
      ['auth.email_verified', 'auth.login', 'auth.login_failed', 'auth.logout'].sort(),
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain('wrong password here');
    expect(serialized).not.toContain(token);
    expect(rows.every((row) => row.organizationId === null)).toBe(true);
  });
});

describe('domain events', () => {
  it('emits organization.created and member.joined with the request correlation id', async () => {
    const owner = await loginAs(ctx, world.orgA.users.owner);
    const created = await owner.post('/app/orgs', { name: `Evented ${uniqueSuffix()}` });
    const orgId = created.json().organization.id as string;
    const events = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.organizationId, orgId)),
    );
    expect(events.map((event) => event.type).sort()).toEqual([
      'member.joined',
      'organization.created',
    ]);
    for (const event of events) {
      expect(event.correlationId).toBe(created.headers['x-request-id']);
      expect(event.actorId).toBe(world.orgA.users.owner.id);
      expect(event.status).toBe('pending');
    }
    const audit = await owner.get(`/app/orgs/${orgId}/audit-logs`);
    expect((audit.json().data as { action: string }[]).map((e) => e.action)).toContain(
      'organization.created',
    );
  });

  it('does not emit events or audit records when an action is rejected', async () => {
    const restricted = await loginAs(ctx, world.orgA.users.restricted);
    const before = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.organizationId, A)),
    );
    const response = await restricted.patch(`/app/orgs/${A}`, { name: 'Nope' });
    expect(response.statusCode).toBe(403);
    const after = await withSystem(ctx.db.db, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.organizationId, A)),
    );
    expect(after.length).toBe(before.length);
  });
});

describe('queued email delivery', () => {
  it('enqueues auth emails as email.send jobs instead of sending inline', async () => {
    const queued = await createTestContext({ queueMailer: true });
    try {
      const email = `queued.${uniqueSuffix()}@example.com`;
      const response = await new TestClient(queued.app).post('/app/auth/register', {
        name: 'Queued',
        email,
        password: TEST_PASSWORD,
      });
      expect(response.statusCode).toBe(202);
      const jobs = queued.jobs.ofType('email.send').filter((job) => job.payload.to === email);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload.template).toBe('verify_email');
      expect(jobs[0]?.payload.data.link).toContain('/verify-email?token=');
    } finally {
      await queued.close();
    }
  });
});
