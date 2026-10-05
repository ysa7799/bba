import { auditLogs, outboxEvents, withSystem } from '@businessos/database';
import { loadEvent } from '@businessos/events';
import { deliverNotifications } from '@businessos/notifications';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(120, 7),
]);

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

async function contact(client: TestClient) {
  const response = await client.post(`/app/orgs/${A}/crm/contacts`, {
    firstName: 'Dana',
    lastName: `Yousif ${uniqueSuffix()}`,
  });
  expect(response.statusCode).toBe(201);
  return response.json().contact as { id: string };
}

function upload(client: TestClient, orgId: string, query: string, body: Buffer) {
  return client.request('POST', `/app/orgs/${orgId}/files?${query}`, body, {
    'content-type': 'application/octet-stream',
  });
}

describe('files API', () => {
  it('attaches files to records with access following the record', async () => {
    const owner = await as(world.orgA.users.owner);
    const record = await contact(owner);
    const query = `entityType=contact&entityId=${record.id}&name=${encodeURIComponent('بطاقة هوية.png')}`;
    const created = await upload(owner, A, query, PNG);
    expect(created.statusCode).toBe(201);
    const { file } = created.json();
    expect(file).toMatchObject({ name: 'بطاقة هوية.png', contentType: 'image/png', inline: true });

    const restricted = await as(world.orgA.users.restricted);
    expect((await upload(restricted, A, query, PNG)).statusCode).toBe(403);
    const listed = await restricted.get(
      `/app/orgs/${A}/files?entityType=contact&entityId=${record.id}`,
    );
    expect(listed.json().data.map((entry: { id: string }) => entry.id)).toEqual([file.id]);

    const download = await restricted.get(`/app/orgs/${A}/files/${file.id}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG)).toBe(true);
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('بطاقة هوية.png')}`,
    );
    const inline = await restricted.get(`/app/orgs/${A}/files/${file.id}/content?inline=1`);
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);

    // Another organization cannot reach it, through either organization's path.
    const outsider = await as(world.orgB.users.owner);
    expect((await outsider.get(`/app/orgs/${A}/files/${file.id}/content`)).statusCode).toBe(404);
    expect((await outsider.get(`/app/orgs/${B}/files/${file.id}/content`)).statusCode).toBe(404);
    expect((await outsider.delete(`/app/orgs/${B}/files/${file.id}`)).statusCode).toBe(404);
    expect(
      (await upload(outsider, B, `entityType=contact&entityId=${record.id}&name=x.png`, PNG))
        .statusCode,
    ).toBe(404);

    expect((await restricted.delete(`/app/orgs/${A}/files/${file.id}`)).statusCode).toBe(403);
    expect((await owner.delete(`/app/orgs/${A}/files/${file.id}`)).statusCode).toBe(204);
    expect((await owner.get(`/app/orgs/${A}/files/${file.id}/content`)).statusCode).toBe(404);
    const audit = await withSystem(ctx.db.db, (tx) =>
      tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.targetId, file.id))),
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual(['files.deleted', 'files.uploaded']);
  });

  it('refuses disguised, oversized and cross-site uploads', async () => {
    const owner = await as(world.orgA.users.owner);
    const record = await contact(owner);
    const query = `entityType=contact&entityId=${record.id}&name=photo.png`;
    const disguised = await upload(owner, A, query, Buffer.from('<html><script>x</script>'));
    expect(disguised.statusCode).toBe(400);
    // An image named like a web page is stored (and later downloaded) as the image it is.
    const renamed = await upload(
      owner,
      A,
      `entityType=contact&entityId=${record.id}&name=${encodeURIComponent('page\u202E.html')}`,
      PNG,
    );
    expect(renamed.statusCode).toBe(201);
    expect(renamed.json().file.name).toBe('page.html.png');
    const oversized = await upload(owner, A, query, Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(oversized.statusCode).toBe(413);
    const crossSite = await ctx.app.inject({
      method: 'POST',
      url: `/app/orgs/${A}/files?${query}`,
      payload: PNG,
      headers: { 'content-type': 'application/octet-stream', origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
  });
});

describe('notifications API', () => {
  it('shows members only their own notifications and preferences', async () => {
    const owner = await as(world.orgA.users.owner);
    const sales = await as(world.orgA.users.sales);
    const created = await owner.post(`/app/orgs/${A}/crm/tasks`, {
      title: 'Send the revised quote',
      assigneeUserId: world.orgA.users.sales.id,
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    const [row] = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.type, 'task.created'), eq(outboxEvents.subjectId, taskId))),
    );
    const event = row ? await loadEvent(ctx.db.db, row.id) : null;
    if (!event) throw new Error('missing event');
    // What the worker's subscriber does.
    await deliverNotifications(
      { db: ctx.db.db, appUrl: ctx.env.APP_URL, enqueueEmail: () => Promise.resolve() },
      event,
    );

    const list = (await sales.get(`/app/orgs/${A}/notifications`)).json();
    const notification = list.data.find(
      (entry: { title: string }) => entry.title === 'Task assigned to you: Send the revised quote',
    );
    expect(notification).toBeTruthy();
    expect((await sales.get(`/app/orgs/${A}/notifications/unread-count`)).json().unread).toBe(
      list.unread,
    );
    const theirs = (await owner.get(`/app/orgs/${A}/notifications`)).json();
    expect(theirs.data.some((entry: { id: string }) => entry.id === notification.id)).toBe(false);
    expect(
      (await owner.post(`/app/orgs/${A}/notifications/${notification.id}/read`)).statusCode,
    ).toBe(404);
    const read = await sales.post(`/app/orgs/${A}/notifications/${notification.id}/read`);
    expect(read.json().notification.readAt).not.toBeNull();
    await sales.post(`/app/orgs/${A}/notifications/read-all`);
    expect((await sales.get(`/app/orgs/${A}/notifications/unread-count`)).json().unread).toBe(0);

    // Preferences list only what the member may receive.
    const restricted = await as(world.orgA.users.restricted);
    const types = (await restricted.get(`/app/orgs/${A}/notifications/preferences`))
      .json()
      .preferences.map((entry: { type: string }) => entry.type);
    expect(types).not.toContain('invoice.paid');
    expect(types).toContain('task.assigned');
    const rejected = await restricted.put(`/app/orgs/${A}/notifications/preferences`, {
      preferences: [{ type: 'invoice.paid', inApp: true, email: true }],
    });
    expect(rejected.statusCode).toBe(400);
    const saved = await sales.put(`/app/orgs/${A}/notifications/preferences`, {
      preferences: [{ type: 'task.assigned', inApp: true, email: false }],
    });
    expect(saved.statusCode).toBe(200);
    expect(
      saved.json().preferences.find((entry: { type: string }) => entry.type === 'task.assigned'),
    ).toEqual({ type: 'task.assigned', inApp: true, email: false });
    // Another organization's member sees none of it.
    const outsider = await as(world.orgB.users.owner);
    expect((await outsider.get(`/app/orgs/${A}/notifications`)).statusCode).toBe(404);
  });
});
