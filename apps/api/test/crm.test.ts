import { processExport, processImport } from '@businessos/crm';
import { membershipRoles, memberships, roles, withSystem } from '@businessos/database';
import { newId } from '@businessos/shared';
import { createTestUser, createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, TestClient, type TestContext } from './helpers';

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

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

/** A member of org A with a custom role holding exactly `permissions`. */
async function memberWith(permissions: string[]): Promise<TestClient> {
  const user = await createTestUser(ctx.db.db, { name: `Custom ${uniqueSuffix()}` });
  // System scope: fixture setup of a custom role and membership.
  await withSystem(ctx.db.db, async (tx) => {
    const [role] = await tx
      .insert(roles)
      .values({ organizationId: A, name: `Custom ${uniqueSuffix()}`, permissions, isSystem: false })
      .returning();
    const [membership] = await tx
      .insert(memberships)
      .values({ id: newId(), organizationId: A, userId: user.id, status: 'active' })
      .returning();
    if (!role || !membership) throw new Error('fixture');
    await tx
      .insert(membershipRoles)
      .values({ organizationId: A, membershipId: membership.id, roleId: role.id });
  });
  return loginAs(ctx, user);
}

describe('CRM permissions', () => {
  it('maps system roles to CRM capabilities', async () => {
    const restricted = await as(world.orgA.users.restricted);
    const sales = await as(world.orgA.users.sales);
    const manager = await as(world.orgA.users.manager);

    expect((await restricted.get(crm(A, '/contacts'))).statusCode).toBe(200);
    expect((await restricted.post(crm(A, '/contacts'), { firstName: 'No' })).statusCode).toBe(403);

    const created = await sales.post(crm(A, '/contacts'), {
      firstName: 'Sales',
      email: `s.${uniqueSuffix()}@example.com`,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().contact.id as string;
    expect((await sales.patch(crm(A, `/contacts/${id}`), { jobTitle: 'Buyer' })).statusCode).toBe(
      200,
    );
    expect((await sales.delete(crm(A, `/contacts/${id}`))).statusCode).toBe(403);
    expect(
      (await sales.post(crm(A, '/contacts/bulk'), { action: 'delete', ids: [id] })).statusCode,
    ).toBe(403);
    expect((await sales.post(crm(A, '/pipelines'), { name: 'Nope' })).statusCode).toBe(403);
    expect(
      (
        await sales.post(crm(A, '/custom-fields'), {
          entityType: 'contact',
          key: 'x',
          label: 'X',
          type: 'text',
        })
      ).statusCode,
    ).toBe(403);
    expect((await sales.post(crm(A, '/exports'), { entityType: 'contact' })).statusCode).toBe(403);

    expect((await manager.delete(crm(A, `/contacts/${id}`))).statusCode).toBe(204);
    expect((await manager.get(crm(A, `/contacts/${id}`))).statusCode).toBe(404);
    // Custom fields are an admin-level setting.
    expect(
      (
        await manager.post(crm(A, '/custom-fields'), {
          entityType: 'contact',
          key: 'x',
          label: 'X',
          type: 'text',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('returns 404 to non-members and unauthenticated callers get 401', async () => {
    const outsider = await as(world.orgB.users.owner);
    expect((await outsider.get(crm(A, '/contacts'))).statusCode).toBe(404);
    expect((await new TestClient(ctx.app).get(crm(A, '/contacts'))).statusCode).toBe(401);
  });

  it('refuses to link records the caller cannot read', async () => {
    const owner = await as(world.orgA.users.owner);
    const contact = (await owner.post(crm(A, '/contacts'), { firstName: 'Linked' })).json().contact;
    const dealOnly = await memberWith([
      'crm.deal.read',
      'crm.deal.create',
      'crm.task.manage',
      'crm.task.read',
    ]);
    expect(
      (await dealOnly.post(crm(A, '/deals'), { name: 'D', contactId: contact.id })).statusCode,
    ).toBe(403);
    expect(
      (await dealOnly.post(crm(A, '/tasks'), { title: 'T', contactId: contact.id })).statusCode,
    ).toBe(403);
    const deal = await dealOnly.post(crm(A, '/deals'), { name: 'Plain deal' });
    expect(deal.statusCode).toBe(201);
    // Linked names are withheld from callers who cannot read the linked record type.
    await owner.patch(crm(A, `/deals/${deal.json().deal.id}`), { contactId: contact.id });
    expect(
      (await dealOnly.get(crm(A, `/deals/${deal.json().deal.id}`))).json().deal.contact,
    ).toBeNull();
    expect(
      (await owner.get(crm(A, `/deals/${deal.json().deal.id}`))).json().deal.contact.name,
    ).toBe('Linked');
  });
});

describe('CRM tenant isolation', () => {
  it('never exposes or modifies another tenant’s records through any CRM resource', async () => {
    const aOwner = await as(world.orgA.users.owner);
    const bAdmin = await as(world.orgB.users.admin);
    const suffix = uniqueSuffix();
    const company = (
      await aOwner.post(crm(A, '/companies'), {
        name: `Iso Co ${suffix}`,
        domain: `iso${suffix}.example`,
      })
    ).json().company;
    const contact = (
      await aOwner.post(crm(A, '/contacts'), {
        firstName: `Iso${suffix}`,
        email: `iso.${suffix}@example.com`,
        companyId: company.id,
      })
    ).json().contact;
    const deal = (
      await aOwner.post(crm(A, '/deals'), { name: `Iso deal ${suffix}`, contactId: contact.id })
    ).json().deal;
    const task = (
      await aOwner.post(crm(A, '/tasks'), { title: `Iso task ${suffix}`, dealId: deal.id })
    ).json().task;
    const note = (
      await aOwner.post(crm(A, `/contacts/${contact.id}/notes`), { body: 'secret note' })
    ).json().note;
    const tag = (await aOwner.post(crm(A, '/tags'), { name: `Iso tag ${suffix}` })).json().tag;
    const field = (
      await aOwner.post(crm(A, '/custom-fields'), {
        entityType: 'contact',
        key: `iso_${suffix}`,
        label: 'Iso',
        type: 'text',
      })
    ).json().field;
    const pipeline = (await aOwner.get(crm(A, '/pipelines'))).json().data[0];
    const imp = (
      await aOwner.post(crm(A, '/imports'), {
        entityType: 'contact',
        fileName: 'a.csv',
        content: 'Email\nx@example.com\n',
      })
    ).json().import;
    const exp = (await aOwner.post(crm(A, '/exports'), { entityType: 'contact' })).json().export;

    // Guessed ids through B's own organization URL: always 404, never data.
    const reads = [
      `/contacts/${contact.id}`,
      `/companies/${company.id}`,
      `/deals/${deal.id}`,
      `/tasks/${task.id}`,
      `/contacts/${contact.id}/notes`,
      `/deals/${deal.id}/notes`,
      `/pipelines/${pipeline.id}/board`,
      `/imports/${imp.id}`,
      `/imports/${imp.id}/preview`,
      `/exports/${exp.id}`,
      `/exports/${exp.id}/download`,
    ];
    for (const path of reads) {
      const response = await bAdmin.get(crm(B, path));
      expect(response.statusCode, path).toBe(404);
    }
    const writes: [string, string, unknown][] = [
      ['PATCH', `/contacts/${contact.id}`, { firstName: 'Hacked' }],
      ['DELETE', `/contacts/${contact.id}`, undefined],
      ['PATCH', `/companies/${company.id}`, { name: 'Hacked' }],
      ['DELETE', `/companies/${company.id}`, undefined],
      ['PATCH', `/deals/${deal.id}`, { name: 'Hacked' }],
      ['POST', `/deals/${deal.id}/move`, { stageId: pipeline.stages[4].id }],
      ['DELETE', `/deals/${deal.id}`, undefined],
      ['PATCH', `/tasks/${task.id}`, { status: 'completed' }],
      ['DELETE', `/tasks/${task.id}`, undefined],
      ['PATCH', `/notes/${note.id}`, { body: 'Hacked' }],
      ['DELETE', `/notes/${note.id}`, undefined],
      ['PATCH', `/tags/${tag.id}`, { name: 'Hacked' }],
      ['DELETE', `/tags/${tag.id}`, undefined],
      ['PATCH', `/custom-fields/${field.id}`, { label: 'Hacked' }],
      ['PATCH', `/pipelines/${pipeline.id}`, { name: 'Hacked' }],
      ['DELETE', `/pipelines/${pipeline.id}`, undefined],
      ['POST', `/pipelines/${pipeline.id}/stages`, { name: 'Hacked' }],
      ['POST', `/contacts/${contact.id}/notes`, { body: 'x' }],
      ['POST', `/imports/${imp.id}/start`, {}],
      ['POST', `/imports/${imp.id}/cancel`, {}],
      ['PATCH', `/imports/${imp.id}`, { mapping: { '0': 'email' } }],
    ];
    for (const [method, path, body] of writes) {
      const response = await bAdmin.request(method as 'POST', crm(B, path), body);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
    }
    // Bulk endpoints silently skip foreign ids.
    const bulk = await bAdmin.post(crm(B, '/contacts/bulk'), {
      action: 'delete',
      ids: [contact.id],
    });
    expect(bulk.json()).toEqual({ affected: 0 });
    // References to A's records from B are rejected.
    expect(
      (await bAdmin.post(crm(B, '/deals'), { name: 'x', contactId: contact.id })).statusCode,
    ).toBe(400);
    expect(
      (await bAdmin.post(crm(B, '/contacts'), { firstName: 'x', companyId: company.id }))
        .statusCode,
    ).toBe(400);
    expect(
      (await bAdmin.post(crm(B, '/contacts'), { firstName: 'x', tagIds: [tag.id] })).statusCode,
    ).toBe(400);
    expect(
      (await bAdmin.post(crm(B, '/deals'), { name: 'x', pipelineId: pipeline.id })).statusCode,
    ).toBe(400);
    // Lists and search in B never contain A's data.
    for (const path of [
      '/contacts',
      '/companies',
      '/deals',
      '/tasks',
      '/tags',
      '/custom-fields',
      '/imports',
      '/exports',
    ]) {
      const body = JSON.stringify((await bAdmin.get(crm(B, path))).json());
      for (const id of [
        contact.id,
        company.id,
        deal.id,
        task.id,
        tag.id,
        field.id,
        imp.id,
        exp.id,
      ]) {
        expect(body, path).not.toContain(id);
      }
    }
    expect((await bAdmin.get(crm(B, `/search?q=Iso${suffix}`))).json().data).toEqual([]);
    expect((await bAdmin.get(crm(B, `/contacts?q=iso.${suffix}`))).json().data).toEqual([]);
    // Everything in A is untouched.
    expect((await aOwner.get(crm(A, `/contacts/${contact.id}`))).json().contact.firstName).toBe(
      `Iso${suffix}`,
    );
    expect((await aOwner.get(crm(A, `/deals/${deal.id}`))).json().deal.status).toBe('open');
    expect((await aOwner.get(crm(A, `/contacts/${contact.id}/notes`))).json().data[0].body).toBe(
      'secret note',
    );
  });

  it('ignores forged tenant and ownership fields (mass assignment)', async () => {
    const aOwner = await as(world.orgA.users.owner);
    const response = await aOwner.post(crm(A, '/contacts'), {
      firstName: 'Forged',
      organizationId: B,
      createdByUserId: world.orgB.users.owner.id,
      deletedAt: new Date().toISOString(),
      id: newId(),
    });
    expect(response.statusCode).toBe(201);
    const contact = response.json().contact;
    expect(contact.createdByUserId).toBe(world.orgA.users.owner.id);
    expect((await aOwner.get(crm(A, `/contacts/${contact.id}`))).statusCode).toBe(200);
    const bAdmin = await as(world.orgB.users.admin);
    expect((await bAdmin.get(crm(B, `/contacts/${contact.id}`))).statusCode).toBe(404);
  });
});

describe('CRM workflow over HTTP', () => {
  it('runs contact → note → task → deal → won with validation errors and audit trail', async () => {
    const owner = await as(world.orgA.users.owner);
    const sales = await as(world.orgA.users.sales);
    const bad = await sales.post(crm(A, '/contacts'), { firstName: 'Bad', email: 'not-an-email' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toEqual([expect.objectContaining({ path: 'email' })]);

    const field = await owner.post(crm(A, '/custom-fields'), {
      entityType: 'contact',
      key: `segment_${uniqueSuffix()}`,
      label: 'Segment',
      type: 'select',
      options: [
        { value: 'smb', label: 'SMB' },
        { value: 'enterprise', label: 'Enterprise' },
      ],
    });
    expect(field.statusCode).toBe(201);
    const key = field.json().field.key as string;

    const contact = (
      await sales.post(crm(A, '/contacts'), {
        firstName: 'Mariam',
        lastName: 'Saleh',
        phone: '3900 1122',
        customFields: { [key]: 'enterprise' },
      })
    ).json().contact;
    expect(contact).toMatchObject({ phone: '+97339001122', customFields: { [key]: 'enterprise' } });
    const filtered = await sales.get(crm(A, `/contacts?cf.${key}=enterprise`));
    expect(filtered.json().data.map((c: { id: string }) => c.id)).toEqual([contact.id]);
    expect((await sales.get(crm(A, '/contacts?cf.unknown_field=x'))).statusCode).toBe(400);

    const note = await sales.post(crm(A, `/contacts/${contact.id}/notes`), {
      body: 'Met at Gulf Expo',
    });
    expect(note.statusCode).toBe(201);
    const restricted = await as(world.orgA.users.restricted);
    expect(
      (await restricted.post(crm(A, `/contacts/${contact.id}/notes`), { body: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await restricted.patch(crm(A, `/notes/${note.json().note.id}`), { body: 'x' })).statusCode,
    ).toBe(403);

    const task = await sales.post(crm(A, '/tasks'), {
      title: 'Send proposal',
      contactId: contact.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(task.statusCode).toBe(201);
    expect(task.json().task).toMatchObject({
      assigneeUserId: world.orgA.users.sales.id,
      contact: { id: contact.id, name: 'Mariam Saleh' },
    });

    const pipelines = (await sales.get(crm(A, '/pipelines'))).json().data;
    const pipeline = pipelines.find((p: { isDefault: boolean }) => p.isDefault);
    const deal = await sales.post(crm(A, '/deals'), {
      name: 'Enterprise licence',
      contactId: contact.id,
      value: { amount: '4500.750', currency: 'BHD' },
      expectedCloseDate: '2026-12-15',
    });
    expect(deal.statusCode).toBe(201);
    const wonStage = pipeline.stages.find((s: { kind: string }) => s.kind === 'won');
    const moved = await sales.post(crm(A, `/deals/${deal.json().deal.id}/move`), {
      stageId: wonStage.id,
    });
    expect(moved.json().deal).toMatchObject({
      status: 'won',
      value: { amount: '4500.750', currency: 'BHD' },
    });
    const board = (await sales.get(crm(A, `/pipelines/${pipeline.id}/board`))).json();
    const wonColumn = board.stages.find((s: { id: string }) => s.id === wonStage.id);
    expect(wonColumn.deals.some((d: { id: string }) => d.id === deal.json().deal.id)).toBe(true);

    const manager = await as(world.orgA.users.manager);
    const bulk = await manager.post(crm(A, '/deals/bulk'), {
      action: 'delete',
      ids: [deal.json().deal.id],
    });
    expect(bulk.json()).toEqual({ affected: 1 });
    const audit = (await owner.get(`/app/orgs/${A}/audit-logs?action=crm.bulk_action`)).json().data;
    expect(audit[0]).toMatchObject({
      actorUserId: world.orgA.users.manager.id,
      metadata: { entity: 'deal', affected: 1 },
    });
  });
});

describe('CRM import and export over HTTP', () => {
  it('stages, maps, previews and runs an import through the worker job', async () => {
    const owner = await as(world.orgA.users.owner);
    const email = `imp.${uniqueSuffix()}@example.com`;
    const upload = await owner.post(crm(A, '/imports'), {
      entityType: 'contact',
      fileName: '../../etc/passwd.csv',
      content: `Full Name,E-mail,Phone\nLayla Hassan,${email},3311 2233\nNo Email,,12\n`,
    });
    expect(upload.statusCode).toBe(201);
    const imp = upload.json().import;
    expect(imp.fileName).not.toContain('/');
    expect(imp.mapping).toEqual({ '0': 'full_name', '1': 'email', '2': 'phone' });
    const preview = (await owner.get(crm(A, `/imports/${imp.id}/preview`))).json().data;
    expect(preview[0].error).toBeNull();
    expect(preview[1].error).toMatch(/phone/i);
    const start = await owner.post(crm(A, `/imports/${imp.id}/start`), {});
    expect(start.json().import.status).toBe('queued');
    const jobs = ctx.jobs.ofType('crm.import').filter((job) => job.payload.importId === imp.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.options.jobId).toBe(`crm-import-${imp.id}`);
    await processImport(ctx.db.db, A, imp.id);
    const done = (await owner.get(crm(A, `/imports/${imp.id}`))).json().import;
    expect(done).toMatchObject({ status: 'completed', createdCount: 1, failedCount: 1 });
    const found = (await owner.get(crm(A, `/contacts?q=${encodeURIComponent(email)}`))).json().data;
    expect(found[0]).toMatchObject({
      firstName: 'Layla',
      lastName: 'Hassan',
      phone: '+97333112233',
      source: 'import',
    });
    const audit = (await owner.get(`/app/orgs/${A}/audit-logs?action=crm.import.started`)).json()
      .data;
    expect(audit.some((entry: { targetId: string }) => entry.targetId === imp.id)).toBe(true);
    // Large bodies beyond the import limit are rejected.
    const tooBig = await owner.post(crm(A, '/imports'), {
      entityType: 'contact',
      fileName: 'big.csv',
      content: `Email\n${'x'.repeat(5 * 1024 * 1024 + 10)}`,
    });
    expect([400, 413]).toContain(tooBig.statusCode);
  });

  it('exports asynchronously, downloads once ready for the requester only, and audits', async () => {
    const owner = await as(world.orgA.users.owner);
    const admin = await as(world.orgA.users.admin);
    await owner.post(crm(A, '/contacts'), {
      firstName: '@SUM(1+1)',
      email: `exp.${uniqueSuffix()}@example.com`,
    });
    const requested = await owner.post(crm(A, '/exports'), {
      entityType: 'contact',
      filters: { q: '@SUM' },
    });
    expect(requested.statusCode).toBe(202);
    const id = requested.json().export.id as string;
    expect((await owner.get(crm(A, `/exports/${id}/download`))).statusCode).toBe(409);
    expect(ctx.jobs.ofType('crm.export').some((job) => job.payload.exportId === id)).toBe(true);
    await processExport(ctx.db.db, A, id);
    const download = await owner.get(crm(A, `/exports/${id}/download`));
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="contacts-\d{12}\.csv"$/,
    );
    expect(download.headers['cache-control']).toBe('no-store');
    expect(download.body).toContain("'@SUM(1+1)");
    expect((await admin.get(crm(A, `/exports/${id}/download`))).statusCode).toBe(404);
    expect(
      (
        await owner.post(crm(A, '/exports'), {
          entityType: 'contact',
          filters: { sort: 'x', status: 'nope' },
        })
      ).statusCode,
    ).toBe(400);
    const actions = (await owner.get(`/app/orgs/${A}/audit-logs?limit=100`))
      .json()
      .data.map((e: { action: string; targetId: string }) => `${e.action}:${e.targetId}`);
    expect(actions).toContain(`crm.export.requested:${id}`);
    expect(actions).toContain(`crm.export.downloaded:${id}`);
  });
});

describe('fixture roles', () => {
  it('custom role helper produces working members', async () => {
    const client = await memberWith(['crm.contact.read']);
    expect((await client.get(crm(A, '/contacts'))).statusCode).toBe(200);
    expect((await client.get(crm(A, '/deals'))).statusCode).toBe(403);
    const rolesForA = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(roles)
        .where(and(eq(roles.organizationId, A), eq(roles.isSystem, false))),
    );
    expect(rolesForA.length).toBeGreaterThan(0);
  });
});
