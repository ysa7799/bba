import { executeRun } from '@businessos/automation';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiEnv } from '../src/env';
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

const auto = (orgId: string, path = '') => `/app/orgs/${orgId}/automation${path}`;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

async function newTag(client: TestClient, orgId = A) {
  const response = await client.post(`/app/orgs/${orgId}/crm/tags`, {
    name: `Auto ${uniqueSuffix()}`,
  });
  expect(response.statusCode).toBe(201);
  return response.json().tag as { id: string };
}

/** A webhook-triggered workflow that creates the sender as a contact and tags them. */
async function webhookWorkflow(client: TestClient, extra: Record<string, unknown>[] = []) {
  const tag = await newTag(client);
  const created = await client.post(auto(A, '/workflows'), {
    name: `Inbound ${uniqueSuffix()}`,
    triggerType: 'webhook.received',
  });
  expect(created.statusCode).toBe(201);
  const { workflow } = created.json();
  const nodes = [
    {
      key: 'contact',
      type: 'action',
      action: 'contact.create',
      config: { firstName: '{{trigger.body.name}}', email: '{{trigger.body.email}}' },
    },
    { key: 'tag', type: 'action', action: 'contact.add_tag', config: { tagId: tag.id } },
    ...extra,
  ];
  const saved = await client.put(auto(A, `/workflows/${workflow.id}/draft`), {
    trigger: { type: 'webhook.received', config: {} },
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]?.key,
      to: node.key,
      branch: 'next',
    })),
    entry: 'contact',
  });
  expect(saved.statusCode).toBe(200);
  const published = await client.post(auto(A, `/workflows/${workflow.id}/publish`));
  expect(published.statusCode).toBe(200);
  const hook = await client.post(auto(A, `/workflows/${workflow.id}/webhook-token`));
  expect(hook.statusCode).toBe(200);
  const url = new URL(hook.json().url as string);
  return { workflow: published.json().workflow, tag, path: url.pathname };
}

function deliver(path: string, body: unknown, headers: Record<string, string> = {}, context = ctx) {
  return context.app.inject({
    method: 'POST',
    url: path,
    payload: body as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Runs the queued workflow jobs like the worker would. */
async function runQueued(context = ctx) {
  for (const job of context.jobs.ofType('automation.run')) {
    await executeRun(
      context.db.db,
      context.app.automation,
      job.payload.organizationId,
      job.payload.runId,
    );
  }
  context.jobs.clear();
}

describe('automation permissions', () => {
  it('lets managers build and members neither see nor change workflows', async () => {
    const manager = await as(world.orgA.users.manager);
    const created = await manager.post(auto(A, '/workflows'), { name: 'Manager workflow' });
    expect(created.statusCode).toBe(201);
    const { workflow } = created.json();
    expect(workflow).toMatchObject({ status: 'draft', triggerType: 'contact.created' });
    for (const user of [world.orgA.users.sales, world.orgA.users.restricted]) {
      const client = await as(user);
      expect((await client.get(auto(A, '/workflows'))).statusCode).toBe(403);
      expect((await client.get(auto(A, `/workflows/${workflow.id}`))).statusCode).toBe(403);
      expect((await client.post(auto(A, '/workflows'), { name: 'x' })).statusCode).toBe(403);
      expect((await client.post(auto(A, `/workflows/${workflow.id}/publish`))).statusCode).toBe(
        403,
      );
    }
    const options = (await manager.get(auto(A, '/builder-options'))).json();
    expect(options.triggers).toContain('form.submitted');
    expect(options.actions).toEqual(
      expect.arrayContaining(['message.email', 'http.request', 'deal.move']),
    );
  });

  it('validates drafts, refuses unsafe webhook targets and ignores privileged fields', async () => {
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(auto(A, '/workflows'), {
      name: 'Validation',
      organizationId: B,
      status: 'active',
    });
    const { workflow } = created.json();
    expect(workflow.status).toBe('draft');
    const save = (body: Record<string, unknown>) =>
      owner.put(auto(A, `/workflows/${workflow.id}/draft`), body);
    const cyclic = await save({
      trigger: { type: 'contact.created', config: {} },
      nodes: [
        { key: 'a', type: 'wait', config: { amount: 1, unit: 'hours' } },
        { key: 'b', type: 'wait', config: { amount: 1, unit: 'hours' } },
      ],
      edges: [
        { from: 'a', to: 'b', branch: 'next' },
        { from: 'b', to: 'a', branch: 'next' },
      ],
      entry: 'a',
    });
    expect(cyclic.statusCode).toBe(400);
    // The test API allows private networks (local receivers); https-only and credentials still apply.
    const unsafe = await save({
      trigger: { type: 'contact.created', config: {} },
      nodes: [
        {
          key: 'hook',
          type: 'action',
          action: 'http.request',
          config: { url: 'ftp://example.com' },
        },
      ],
      edges: [],
      entry: 'hook',
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error.details[0].path).toBe('nodes.0.config.url');
    expect((await owner.post(auto(A, `/workflows/${workflow.id}/publish`))).statusCode).toBe(400);
  });
});

describe('inbound webhooks and runs', () => {
  it('starts a run per delivery, executes it and shows its steps and logs', async () => {
    const owner = await as(world.orgA.users.owner);
    const { workflow, tag, path } = await webhookWorkflow(owner);
    const email = `lead-${uniqueSuffix()}@example.com`.toLowerCase();
    const first = await deliver(path, { name: 'Fatima', email }, { 'idempotency-key': 'order-42' });
    expect(first.statusCode).toBe(202);
    const again = await deliver(path, { name: 'Fatima', email }, { 'idempotency-key': 'order-42' });
    expect(again.json()).toEqual({ runId: first.json().runId, duplicate: true });
    await runQueued();

    const runs = (await owner.get(auto(A, `/workflows/${workflow.id}/runs`))).json();
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0]).toMatchObject({ status: 'completed', contact: { name: 'Fatima' } });
    const detail = (await owner.get(auto(A, `/runs/${first.json().runId}`))).json().run;
    expect(
      detail.steps.map((step: { nodeKey: string; status: string }) => [step.nodeKey, step.status]),
    ).toEqual([
      ['contact', 'succeeded'],
      ['tag', 'succeeded'],
    ]);
    expect(detail.triggerData).toEqual({ body: { name: 'Fatima', email } });
    const contact = (await owner.get(`/app/orgs/${A}/crm/contacts/${detail.contact.id}`)).json()
      .contact;
    expect(contact.tags.map((t: { id: string }) => t.id)).toEqual([tag.id]);
  });

  it('rejects unknown tokens, non-object bodies and paused workflows', async () => {
    const owner = await as(world.orgA.users.owner);
    const { workflow, path } = await webhookWorkflow(owner);
    expect(
      (await deliver('/webhooks/automation/AbCdEf0123456789AbCdEf0123456789AbCdEf01234', {}))
        .statusCode,
    ).toBe(404);
    expect((await deliver('/webhooks/automation/short', {})).statusCode).toBe(404);
    expect((await deliver(path, [1, 2, 3])).statusCode).toBe(400);
    expect(
      (await deliver(path, { ok: true }, { 'idempotency-key': 'bad key with spaces' })).statusCode,
    ).toBe(400);
    expect((await owner.post(auto(A, `/workflows/${workflow.id}/pause`))).statusCode).toBe(200);
    expect((await deliver(path, { ok: true })).statusCode).toBe(404);
    expect((await owner.post(auto(A, `/workflows/${workflow.id}/resume`))).statusCode).toBe(200);
    expect((await deliver(path, { ok: true })).statusCode).toBe(202);
    // A new URL replaces the old one.
    expect((await owner.post(auto(A, `/workflows/${workflow.id}/webhook-token`))).statusCode).toBe(
      200,
    );
    expect((await deliver(path, { ok: true })).statusCode).toBe(404);
    ctx.jobs.clear();
  });

  it('retries failed runs and cancels waiting ones (audited)', async () => {
    const owner = await as(world.orgA.users.owner);
    // No email in the payload: "create contact" has nothing to work with and fails.
    const { workflow, path } = await webhookWorkflow(owner, [
      { key: 'wait', type: 'wait', config: { amount: 1, unit: 'days' } },
    ]);
    const failed = (await deliver(path, {})).json().runId as string;
    await runQueued();
    let run = (await owner.get(auto(A, `/runs/${failed}`))).json().run;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('contact');
    const retried = await owner.post(auto(A, `/runs/${failed}/retry`));
    expect(retried.statusCode).toBe(200);
    expect(ctx.jobs.ofType('automation.run').some((job) => job.payload.runId === failed)).toBe(
      true,
    );
    await runQueued();
    run = (await owner.get(auto(A, `/runs/${failed}`))).json().run;
    expect(run.status).toBe('failed');

    const waiting = (
      await deliver(path, { name: 'Wait', email: `w-${uniqueSuffix()}@example.com` })
    ).json().runId as string;
    await runQueued();
    expect((await owner.get(auto(A, `/runs/${waiting}`))).json().run.status).toBe('waiting');
    const cancelled = await owner.post(auto(A, `/runs/${waiting}/cancel`));
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');
    expect((await owner.post(auto(A, `/runs/${waiting}/cancel`))).statusCode).toBe(409);
    const audit = (
      await owner.get(`/app/orgs/${A}/audit-logs?action=automation.run.cancelled`)
    ).json();
    expect(audit.data.some((entry: { targetId: string }) => entry.targetId === waiting)).toBe(true);
    const archived = await owner.post(auto(A, `/workflows/${workflow.id}/archive`));
    expect(archived.json()).toMatchObject({ cancelledRuns: 0, workflow: { status: 'archived' } });
  });
});

describe('automation tenant isolation over HTTP', () => {
  it("hides one organization's workflows and runs from another", async () => {
    const owner = await as(world.orgA.users.owner);
    const { workflow, path } = await webhookWorkflow(owner);
    const runId = (
      await deliver(path, { name: 'Iso', email: `iso-${uniqueSuffix()}@example.com` })
    ).json().runId as string;
    ctx.jobs.clear();
    const bAdmin = await as(world.orgB.users.owner);
    expect((await bAdmin.get(auto(A, '/workflows'))).statusCode).toBe(404);
    expect((await bAdmin.get(auto(B, `/workflows/${workflow.id}`))).statusCode).toBe(404);
    expect((await bAdmin.put(auto(B, `/workflows/${workflow.id}/draft`), {})).statusCode).toBe(400);
    expect((await bAdmin.post(auto(B, `/workflows/${workflow.id}/publish`))).statusCode).toBe(404);
    expect((await bAdmin.post(auto(B, `/workflows/${workflow.id}/pause`))).statusCode).toBe(404);
    expect((await bAdmin.post(auto(B, `/workflows/${workflow.id}/webhook-token`))).statusCode).toBe(
      404,
    );
    expect((await bAdmin.get(auto(B, `/workflows/${workflow.id}/runs`))).statusCode).toBe(404);
    expect((await bAdmin.get(auto(B, `/runs/${runId}`))).statusCode).toBe(404);
    expect((await bAdmin.post(auto(B, `/runs/${runId}/cancel`))).statusCode).toBe(404);
    expect((await bAdmin.post(auto(B, `/runs/${runId}/retry`))).statusCode).toBe(404);
  });
});

describe('automation configuration and logging', () => {
  it('refuses private-network access for workflows in production', () => {
    expect(() =>
      loadApiEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379/0',
        APP_URL: 'https://app.example.com',
        API_PUBLIC_URL: 'https://api.example.com',
        CORS_ORIGINS: 'https://app.example.com',
        CREDENTIALS_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
        FILES_STORAGE: 's3',
        S3_BUCKET: 'businessos-files',
        AUTOMATION_ALLOW_PRIVATE_NETWORK: 'true',
      }),
    ).toThrow(/AUTOMATION_ALLOW_PRIVATE_NETWORK/);
  });

  it('never writes inbound webhook tokens to the logs', async () => {
    const lines: string[] = [];
    const logged = await createTestContext({
      env: { LOG_LEVEL: 'info', AUTOMATION_ALLOW_PRIVATE_NETWORK: 'true' },
      logStream: { write: (line) => void lines.push(line) },
    });
    try {
      const owner = await loginAs(logged, world.orgA.users.owner);
      const created = (
        await owner.post(auto(A, '/workflows'), { name: 'Logged', triggerType: 'webhook.received' })
      ).json().workflow;
      const url = new URL(
        (await owner.post(auto(A, `/workflows/${created.id}/webhook-token`))).json().url as string,
      );
      const token = url.pathname.split('/').at(-1) ?? '';
      expect(token).toHaveLength(43);
      await deliver(url.pathname, { hello: 'world' }, {}, logged);
      const output = lines.join('');
      expect(output).toContain('/webhooks/automation/[REDACTED]');
      expect(output).not.toContain(token);
    } finally {
      await logged.close();
    }
  });
});
