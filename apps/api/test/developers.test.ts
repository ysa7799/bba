import {
  auditLogs,
  entitlementOverrides,
  outboxEvents,
  withSystem,
  withTenant,
} from '@businessos/database';
import { createContact } from '@businessos/crm';
import { verifyWebhookSignature } from '@businessos/webhooks';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

async function enableApi(organizationId: string, value: boolean) {
  await withSystem(ctx.db.db, (tx) =>
    tx
      .insert(entitlementOverrides)
      .values({ organizationId, key: 'api.enabled', value: { value }, reason: 'developer tests' })
      .onConflictDoUpdate({
        target: [entitlementOverrides.organizationId, entitlementOverrides.key],
        set: { value: { value } },
      }),
  );
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { WEBHOOKS_ALLOW_PRIVATE_NETWORK: 'true' } });
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
  await enableApi(A, true);
  await enableApi(B, true);
});

afterAll(async () => {
  await ctx.close();
});

/** Calls the public API with a key (no cookies). */
function v1(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  key: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function issueKey(orgId: string, owner: { id: string; email: string }, scopes: string[]) {
  const client = await as(owner);
  const response = await client.post(`/app/orgs/${orgId}/developers/api-keys`, {
    name: `Integration ${uniqueSuffix()}`,
    scopes,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ apiKey: { id: string; prefix: string }; key: string }>();
}

describe('API key management', () => {
  it('lets owners issue keys within their permissions and shows them once', async () => {
    const owner = await as(world.orgA.users.owner);
    const overview = (await owner.get(`/app/orgs/${A}/developers`)).json();
    expect(overview.enabled).toBe(true);
    expect(overview.scopes.map((entry: { scope: string }) => entry.scope)).toContain(
      'crm.contact.read',
    );
    expect(overview.apiBaseUrl).toMatch(/\/api\/v1$/);

    const { apiKey, key } = await issueKey(A, world.orgA.users.owner, ['crm.contact.read']);
    const listed = (await owner.get(`/app/orgs/${A}/developers/api-keys`)).json();
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(listed.data[0]).toMatchObject({ id: apiKey.id, status: 'active' });

    // Members without `api.manage` cannot see or create keys.
    const manager = await as(world.orgA.users.manager);
    expect((await manager.get(`/app/orgs/${A}/developers/api-keys`)).statusCode).toBe(403);
    expect(
      (
        await manager.post(`/app/orgs/${A}/developers/api-keys`, {
          name: 'x',
          scopes: ['crm.contact.read'],
        })
      ).statusCode,
    ).toBe(403);

    // Another organization's owner cannot revoke it.
    const outsider = await as(world.orgB.users.owner);
    expect(
      (await outsider.post(`/app/orgs/${B}/developers/api-keys/${apiKey.id}/revoke`)).statusCode,
    ).toBe(404);
    expect(
      (await outsider.post(`/app/orgs/${A}/developers/api-keys/${apiKey.id}/revoke`)).statusCode,
    ).toBe(404);

    const revoked = await owner.post(`/app/orgs/${A}/developers/api-keys/${apiKey.id}/revoke`);
    expect(revoked.json().apiKey.status).toBe('revoked');
    expect((await v1('GET', '/me', key)).statusCode).toBe(401);
    const audit = await withSystem(ctx.db.db, (tx) =>
      tx
        .select({ action: auditLogs.action, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.targetId, apiKey.id))),
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'api_key.created',
      'api_key.revoked',
    ]);
    expect(JSON.stringify(audit)).not.toContain(key);
  });

  it('needs the plan to include the API', async () => {
    const { key } = await issueKey(B, world.orgB.users.owner, ['crm.contact.read']);
    await enableApi(B, false);
    try {
      const owner = await as(world.orgB.users.owner);
      const refused = await owner.post(`/app/orgs/${B}/developers/api-keys`, {
        name: 'x',
        scopes: ['crm.contact.read'],
      });
      expect(refused.statusCode).toBe(402);
      expect((await v1('GET', '/me', key)).statusCode).toBe(402);
      // Existing keys stay visible (and revocable) after a downgrade.
      expect((await owner.get(`/app/orgs/${B}/developers/api-keys`)).statusCode).toBe(200);
    } finally {
      await enableApi(B, true);
    }
  });
});

describe('public API', () => {
  it('authenticates with a key only', async () => {
    expect((await v1('GET', '/me', null)).statusCode).toBe(401);
    expect((await v1('GET', '/me', 'bos_not-a-real-key')).statusCode).toBe(401);
    const malformed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(malformed.statusCode).toBe(401);
    // A signed-in session is not an API credential.
    const owner = await as(world.orgA.users.owner);
    expect((await owner.get('/api/v1/me')).statusCode).toBe(401);

    const { key } = await issueKey(A, world.orgA.users.owner, ['crm.contact.read']);
    const me = await v1('GET', '/me', key);
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.json()).toMatchObject({
      apiKey: { scopes: ['crm.contact.read'] },
      organization: { id: A },
    });
  });

  it('enforces scopes per operation', async () => {
    const { key } = await issueKey(A, world.orgA.users.owner, ['crm.contact.read']);
    expect((await v1('GET', '/contacts', key)).statusCode).toBe(200);
    const write = await v1('POST', '/contacts', key, { firstName: 'Nope' });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.message).toContain('crm.contact.create');
    expect((await v1('GET', '/deals', key)).statusCode).toBe(403);
    expect((await v1('GET', '/invoices', key)).statusCode).toBe(403);
  });

  it('keeps every key inside its own organization', async () => {
    const { key } = await issueKey(A, world.orgA.users.owner, [
      'crm.contact.read',
      'crm.contact.update',
      'crm.contact.delete',
      'crm.deal.create',
      'crm.deal.read',
    ]);
    // A contact in organization B.
    const foreign = await withTenant(
      ctx.db.db,
      { organizationId: B, userId: world.orgB.users.owner.id },
      (tx) =>
        createContact(
          tx,
          {
            organizationId: B,
            countryCode: 'BH',
            defaultCurrency: 'BHD',
            timezone: 'Asia/Bahrain',
            actor: { type: 'user', userId: world.orgB.users.owner.id },
          },
          { firstName: 'Foreign', lastName: `Contact ${uniqueSuffix()}` },
        ),
    );
    expect((await v1('GET', `/contacts/${foreign.id}`, key)).statusCode).toBe(404);
    expect(
      (await v1('PATCH', `/contacts/${foreign.id}`, key, { firstName: 'Changed' })).statusCode,
    ).toBe(404);
    expect((await v1('DELETE', `/contacts/${foreign.id}`, key)).statusCode).toBe(404);
    const search = (await v1('GET', `/contacts?q=${encodeURIComponent('Foreign')}`, key)).json();
    expect(search.data.some((entry: { id: string }) => entry.id === foreign.id)).toBe(false);
    // Linking another organization's record is refused.
    const linked = await v1('POST', '/deals', key, { name: 'Cross', contactId: foreign.id });
    expect([400, 404, 422]).toContain(linked.statusCode);
    // Nothing in the request can choose the organization.
    const sneaky = await v1('GET', `/contacts?organizationId=${B}`, key);
    expect(sneaky.statusCode).toBe(200);
    expect(sneaky.json().data.every((entry: { id: string }) => entry.id !== foreign.id)).toBe(true);
  });

  it('creates idempotently, records the key as actor and audits deletions', async () => {
    const { apiKey, key } = await issueKey(A, world.orgA.users.owner, [
      'crm.contact.create',
      'crm.contact.delete',
    ]);
    const body = { firstName: 'Idem', lastName: `Potent ${uniqueSuffix()}` };
    const first = await v1('POST', '/contacts', key, body, { 'idempotency-key': 'create-1' });
    expect(first.statusCode).toBe(201);
    const again = await v1('POST', '/contacts', key, body, { 'idempotency-key': 'create-1' });
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().contact.id).toBe(first.json().contact.id);
    const different = await v1(
      'POST',
      '/contacts',
      key,
      { firstName: 'Other' },
      { 'idempotency-key': 'create-1' },
    );
    expect(different.statusCode).toBe(422);
    const invalidKey = await v1('POST', '/contacts', key, body, { 'idempotency-key': 'has space' });
    expect(invalidKey.statusCode).toBe(400);

    const contactId = first.json().contact.id as string;
    const [event] = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(eq(outboxEvents.type, 'contact.created'), eq(outboxEvents.subjectId, contactId)),
        ),
    );
    expect(event).toMatchObject({ actorType: 'api_key', actorId: apiKey.id });

    expect((await v1('DELETE', `/contacts/${contactId}`, key)).statusCode).toBe(204);
    const [audit] = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.targetId, contactId))),
    );
    expect(audit).toMatchObject({ action: 'crm.contact.deleted', actorType: 'api_key' });
    expect(audit?.actorLabel).toContain(apiKey.prefix);
  });

  it('rate limits per key', async () => {
    const strict = await createTestContext({
      env: { WEBHOOKS_ALLOW_PRIVATE_NETWORK: 'true' },
      rateLimits: { publicApiKey: { limit: 2, windowSeconds: 60 } },
    });
    try {
      const { key } = await issueKey(A, world.orgA.users.owner, ['crm.contact.read']);
      const call = () =>
        strict.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${key}` },
        });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      const limited = await call();
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      await strict.close();
    }
  });
});

describe('webhook endpoints', () => {
  let server: Server;
  let url = '';
  const received: { body: string; signature: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received.push({ body, signature: String(request.headers['businessos-signature']) });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('manages endpoints, sends signed test events and lists deliveries', async () => {
    const owner = await as(world.orgA.users.owner);
    const created = await owner.post(`/app/orgs/${A}/developers/webhooks`, {
      url,
      events: ['contact.created', 'deal.won'],
      description: 'CRM sync',
    });
    expect(created.statusCode).toBe(201);
    const { endpoint, secret } = created.json<{ endpoint: { id: string }; secret: string }>();
    expect(secret).toMatch(/^whsec_/);
    const listed = (await owner.get(`/app/orgs/${A}/developers/webhooks`)).json();
    expect(JSON.stringify(listed)).not.toContain(secret);

    const test = await owner.post(`/app/orgs/${A}/developers/webhooks/${endpoint.id}/test`);
    expect(test.statusCode).toBe(202);
    const [job] = ctx.jobs
      .ofType('webhook.deliver')
      .filter((entry) => entry.payload.deliveryId === test.json().deliveryId);
    expect(job?.payload).toMatchObject({ organizationId: A, attempt: 1 });
    // What the worker does with the job.
    const { attemptDelivery } = await import('@businessos/webhooks');
    expect(await attemptDelivery(ctx.app.webhooks, job?.payload ?? never())).toBe('succeeded');
    const delivered = received.at(-1);
    expect(
      verifyWebhookSignature({
        body: delivered?.body ?? '',
        header: delivered?.signature,
        secret,
      }),
    ).toBe(true);

    const deliveries = (
      await owner.get(`/app/orgs/${A}/developers/webhooks/${endpoint.id}/deliveries`)
    ).json();
    expect(deliveries.data[0]).toMatchObject({ eventType: 'webhook.test', status: 'succeeded' });
    const detail = await owner.get(
      `/app/orgs/${A}/developers/webhooks/${endpoint.id}/deliveries/${deliveries.data[0].id}`,
    );
    expect(detail.json().delivery.body).toBe(delivered?.body);

    const rotated = await owner.post(
      `/app/orgs/${A}/developers/webhooks/${endpoint.id}/rotate-secret`,
    );
    expect(rotated.json().secret).not.toBe(secret);
    const off = await owner.patch(`/app/orgs/${A}/developers/webhooks/${endpoint.id}`, {
      enabled: false,
    });
    expect(off.json().endpoint).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    expect(
      (await owner.post(`/app/orgs/${A}/developers/webhooks/${endpoint.id}/test`)).statusCode,
    ).toBe(409);

    // Organization B's owner reaches none of it.
    const outsider = await as(world.orgB.users.owner);
    for (const path of [
      `/app/orgs/${B}/developers/webhooks/${endpoint.id}`,
      `/app/orgs/${B}/developers/webhooks/${endpoint.id}/deliveries`,
      `/app/orgs/${A}/developers/webhooks/${endpoint.id}`,
    ]) {
      expect((await outsider.get(path)).statusCode, path).toBe(404);
    }
    expect(
      (
        await outsider.patch(`/app/orgs/${B}/developers/webhooks/${endpoint.id}`, {
          enabled: true,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await outsider.delete(`/app/orgs/${B}/developers/webhooks/${endpoint.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await outsider.post(`/app/orgs/${B}/developers/webhooks/${endpoint.id}/rotate-secret`))
        .statusCode,
    ).toBe(404);

    expect(
      (await owner.delete(`/app/orgs/${A}/developers/webhooks/${endpoint.id}`)).statusCode,
    ).toBe(204);
    const audit = await withSystem(ctx.db.db, (tx) =>
      tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.targetId, endpoint.id))),
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'webhook.created',
      'webhook.deleted',
      'webhook.secret_rotated',
      'webhook.updated',
    ]);
  });

  it('refuses unsafe endpoint URLs in a strict configuration', async () => {
    const strict = await createTestContext();
    try {
      const owner = await loginAs(strict, world.orgA.users.owner);
      for (const target of ['http://hooks.example.com/x', 'https://192.168.1.10/x', url]) {
        const response = await owner.post(`/app/orgs/${A}/developers/webhooks`, {
          url: target,
          events: ['deal.won'],
        });
        expect(response.statusCode, target).toBe(400);
      }
    } finally {
      await strict.close();
    }
  });
});

function never(): never {
  throw new Error('missing job');
}
