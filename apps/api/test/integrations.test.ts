import { FakeCalendarProvider } from '@businessos/calendar';
import { auditLogs, calendarConnections, withSystem } from '@businessos/database';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, loginAs, type TestClient, type TestContext } from './helpers';

let ctx: TestContext;
let world: TestWorld;
let A: string;
let B: string;
const fakeCalendar = new FakeCalendarProvider();
const clients = new Map<string, TestClient>();

async function as(user: { id: string; email: string }): Promise<TestClient> {
  const cached = clients.get(user.id);
  if (cached) return cached;
  const client = await loginAs(ctx, user);
  clients.set(user.id, client);
  return client;
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: { INTEGRATIONS_FAKE_PROVIDERS: 'true' },
    configure: (app) => {
      // The fake calendar the fake OAuth provider's accounts connect to.
      app.calendar.providers.register(fakeCalendar);
    },
  });
  world = await createTestWorld(ctx.db.db);
  A = world.orgA.organization.id;
  B = world.orgB.organization.id;
});

afterAll(async () => {
  await ctx.close();
});

async function calendarFor(orgId: string, owner: { id: string; email: string }) {
  const client = await as(owner);
  const response = await client.post(`/app/orgs/${orgId}/calendar/calendars`, {
    name: `Room ${uniqueSuffix()}`,
  });
  expect(response.statusCode).toBe(201);
  return response.json().calendar as { id: string };
}

/** Starts a connection and follows the fake provider's consent the way the web app does. */
async function connectThroughOAuth(
  client: TestClient,
  orgId: string,
  calendarId: string,
  email: string,
) {
  const started = await client.post(`/app/orgs/${orgId}/integrations/oauth/start`, {
    provider: 'fake_oauth',
    purpose: 'calendar',
    context: { calendarId },
  });
  expect(started.statusCode).toBe(200);
  const authorizeUrl = new URL(started.json().authorizeUrl as string);
  const state = authorizeUrl.searchParams.get('state') ?? '';
  return {
    state,
    complete: () => client.post('/app/oauth/complete', { state, code: `fake.${email}` }),
  };
}

describe('connected accounts', () => {
  it('connects a calendar through OAuth and uses the account’s fresh tokens', async () => {
    const owner = await as(world.orgA.users.owner);
    const calendar = await calendarFor(A, world.orgA.users.owner);
    const providers = (await owner.get(`/app/orgs/${A}/integrations/providers`)).json();
    expect(providers.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'google', configured: false }),
        expect.objectContaining({ key: 'microsoft', configured: false }),
        expect.objectContaining({ key: 'fake_oauth', configured: true }),
      ]),
    );
    // Without a platform OAuth client Google cannot be started.
    const google = await owner.post(`/app/orgs/${A}/integrations/oauth/start`, {
      provider: 'google',
      purpose: 'calendar',
      context: { calendarId: calendar.id },
    });
    expect(google.statusCode).toBe(409);
    expect(google.json().error.message).toContain('CONFIGURATION_REQUIRED');

    const { complete } = await connectThroughOAuth(owner, A, calendar.id, 'host@example.com');
    const completed = await complete();
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      account: { provider: 'fake_oauth', accountLabel: 'host@example.com', status: 'active' },
      redirectTo: `/o/${A}/calendar/settings?calendar=${calendar.id}`,
    });
    const accountId = completed.json().account.id as string;

    const connections = (
      await owner.get(`/app/orgs/${A}/calendar/calendars/${calendar.id}/connections`)
    ).json();
    expect(connections.data[0]).toMatchObject({
      provider: 'fake_calendar',
      status: 'active',
      integrationAccountId: accountId,
    });
    // Availability reads busy times with a token from the account (never stored on the link).
    const token = await ctx.app.calendar.tokens?.accessToken(A, accountId);
    expect(token).toMatch(/^fake-access-/);

    // Accounts are listed without any secret material.
    const accounts = await owner.get(`/app/orgs/${A}/integrations/accounts`);
    expect(JSON.stringify(accounts.json())).not.toMatch(/fake-(access|refresh)-/);

    expect(
      (await owner.delete(`/app/orgs/${A}/integrations/accounts/${accountId}`)).statusCode,
    ).toBe(204);
    const [link] = await withSystem(ctx.db.db, (tx) =>
      tx
        .select()
        .from(calendarConnections)
        .where(eq(calendarConnections.integrationAccountId, accountId)),
    );
    expect(link?.status).toBe('disconnected');
    const audit = await withSystem(ctx.db.db, (tx) =>
      tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, A), eq(auditLogs.targetId, accountId))),
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'integration.connected',
      'integration.disconnected',
    ]);
  });

  it('only lets people connect calendars they may edit, and only finish their own', async () => {
    const calendar = await calendarFor(A, world.orgA.users.owner);
    // A restricted member cannot connect someone else's calendar.
    const restricted = await as(world.orgA.users.restricted);
    const refused = await restricted.post(`/app/orgs/${A}/integrations/oauth/start`, {
      provider: 'fake_oauth',
      purpose: 'calendar',
      context: { calendarId: calendar.id },
    });
    expect(refused.statusCode).toBe(403);
    // Another organization's calendar does not exist for this member.
    const otherCalendar = await calendarFor(B, world.orgB.users.owner);
    const owner = await as(world.orgA.users.owner);
    const foreign = await owner.post(`/app/orgs/${A}/integrations/oauth/start`, {
      provider: 'fake_oauth',
      purpose: 'calendar',
      context: { calendarId: otherCalendar.id },
    });
    expect(foreign.statusCode).toBe(404);

    // A state started by the owner cannot be completed by another member's session.
    const { state } = await connectThroughOAuth(owner, A, calendar.id, 'owner2@example.com');
    const sales = await as(world.orgA.users.sales);
    const hijack = await sales.post('/app/oauth/complete', {
      state,
      code: 'fake.attacker@example.com',
    });
    expect(hijack.statusCode).toBe(403);
    // Nor after it was used once.
    expect(
      (await owner.post('/app/oauth/complete', { state, code: 'fake.x@example.com' })).statusCode,
    ).toBe(400);
  });

  it('keeps accounts private to their member unless managed, and inside the organization', async () => {
    const managerCalendar = await calendarFor(A, world.orgA.users.owner);
    const owner = await as(world.orgA.users.owner);
    const { complete } = await connectThroughOAuth(owner, A, managerCalendar.id, 'own@example.com');
    const accountId = (await complete()).json().account.id as string;

    // Members without `integrations.manage` see only their own accounts and cannot remove others'.
    const sales = await as(world.orgA.users.sales);
    const seen = (await sales.get(`/app/orgs/${A}/integrations/accounts`)).json();
    expect(seen.data.some((entry: { id: string }) => entry.id === accountId)).toBe(false);
    expect(
      (await sales.delete(`/app/orgs/${A}/integrations/accounts/${accountId}`)).statusCode,
    ).toBe(403);
    // Another organization cannot reach it at all.
    const outsider = await as(world.orgB.users.owner);
    expect(
      (await outsider.delete(`/app/orgs/${B}/integrations/accounts/${accountId}`)).statusCode,
    ).toBe(404);
    expect(
      (await outsider.get(`/app/orgs/${B}/integrations/accounts`))
        .json()
        .data.some((entry: { id: string }) => entry.id === accountId),
    ).toBe(false);
    // The completion route cannot be used without a session or across sites.
    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/app/oauth/complete',
      payload: { state: 'x'.repeat(43), code: 'fake.a@example.com' },
      headers: { origin: 'http://localhost:3000' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses the fake provider in production configuration', async () => {
    const { loadApiEnv } = await import('../src/env');
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
        S3_BUCKET: 'files',
        INTEGRATIONS_FAKE_PROVIDERS: 'true',
      }),
    ).toThrow(/INTEGRATIONS_FAKE_PROVIDERS/);
    expect(() =>
      loadApiEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379/0',
        APP_URL: 'http://localhost:3000',
        API_PUBLIC_URL: 'http://localhost:4000',
        GOOGLE_OAUTH_CLIENT_ID: 'only-the-id',
      }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_SECRET/);
  });
});
