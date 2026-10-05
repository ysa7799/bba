import { createInvitation, tokenFromLink } from '@businessos/auth';
import { sessions, withSystem, withTenant } from '@businessos/database';
import { newId } from '@businessos/shared';
import { createTestWorld, uniqueSuffix, type TestWorld } from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  loginAs,
  TEST_ORIGIN,
  TEST_PASSWORD,
  TestClient,
  type TestContext,
} from './helpers';

let ctx: TestContext;
let world: TestWorld;

beforeAll(async () => {
  ctx = await createTestContext();
  world = await createTestWorld(ctx.db.db);
});

afterAll(async () => {
  await ctx.close();
});

function address(label: string) {
  return `${label}.${uniqueSuffix()}@example.com`;
}

async function signUp(email = address('user')): Promise<TestClient> {
  const client = new TestClient(ctx.app);
  const registered = await client.post('/app/auth/register', {
    name: 'Mariam',
    email,
    password: TEST_PASSWORD,
  });
  expect(registered.statusCode).toBe(202);
  const sent = ctx.mailer.lastTo(email);
  if (sent?.kind !== 'verify_email') throw new Error('missing verification email');
  const verified = await client.post('/app/auth/verify-email', { token: tokenFromLink(sent.link) });
  expect(verified.statusCode).toBe(200);
  const login = await client.post('/app/auth/login', { email, password: TEST_PASSWORD });
  expect(login.statusCode).toBe(200);
  return client;
}

describe('registration and login over HTTP', () => {
  it('runs register → verify → login → me', async () => {
    const email = address('flow');
    const client = await signUp(email);
    const me = await client.get('/app/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email, emailVerified: true },
      organizations: [],
      activeOrganizationId: null,
    });
    expect(me.body).not.toContain('passwordHash');
    expect(me.body).not.toContain('argon2');
  });

  it('sets a hardened session cookie', async () => {
    const email = address('cookie');
    const client = new TestClient(ctx.app);
    await client.post('/app/auth/register', { name: 'C', email, password: TEST_PASSWORD });
    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'verify_email') throw new Error('missing email');
    await client.post('/app/auth/verify-email', { token: tokenFromLink(sent.link) });
    const login = await client.post('/app/auth/login', { email, password: TEST_PASSWORD });
    const cookie = login.cookies.find((c) => c.name === 'bos_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.json()).toEqual({ user: expect.objectContaining({ email }) });
    expect(login.body).not.toContain(cookie?.value ?? 'x');
  });

  it('responds identically for new and existing emails', async () => {
    const email = address('enum');
    await signUp(email);
    const anonymous = new TestClient(ctx.app);
    const again = await anonymous.post('/app/auth/register', {
      name: 'Other',
      email,
      password: 'another password 12',
    });
    const fresh = await anonymous.post('/app/auth/register', {
      name: 'Other',
      email: address('fresh'),
      password: 'another password 12',
    });
    expect(again.statusCode).toBe(fresh.statusCode);
    expect(again.json()).toEqual(fresh.json());

    const forgotKnown = await anonymous.post('/app/auth/forgot-password', { email });
    const forgotUnknown = await anonymous.post('/app/auth/forgot-password', {
      email: address('nobody'),
    });
    expect(forgotKnown.statusCode).toBe(202);
    expect(forgotKnown.json()).toEqual(forgotUnknown.json());
  });

  it('rejects wrong passwords and unverified accounts with distinct safe errors', async () => {
    const email = address('unverified');
    const client = new TestClient(ctx.app);
    await client.post('/app/auth/register', { name: 'U', email, password: TEST_PASSWORD });
    const unverified = await client.post('/app/auth/login', { email, password: TEST_PASSWORD });
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json().error.code).toBe('email_not_verified');
    const wrong = await client.post('/app/auth/login', { email, password: 'nope nope nope' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe('Invalid email or password');
  });

  it('validates input with field-level details', async () => {
    const client = new TestClient(ctx.app);
    const response = await client.post('/app/auth/register', {
      name: '',
      email: 'bad',
      password: 'short',
    });
    expect(response.statusCode).toBe(400);
    const paths = response.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});

describe('protected routes', () => {
  const protectedRoutes: [method: 'GET' | 'POST', url: string][] = [
    ['GET', '/app/me'],
    ['POST', '/app/me/active-organization'],
    ['POST', '/app/me/password'],
    ['GET', '/app/orgs'],
    ['POST', '/app/orgs'],
    ['GET', `/app/orgs/${newId()}`],
    ['GET', `/app/orgs/${newId()}/members`],
    ['POST', '/app/invitations/accept'],
  ];

  it.each(protectedRoutes)('%s %s requires a session', async (method, url) => {
    const client = new TestClient(ctx.app);
    const response = await client.request(method, url, method === 'POST' ? {} : undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
  });

  it('rejects forged, malformed and revoked session cookies and clears them', async () => {
    for (const value of ['x', 'A'.repeat(43), "' OR 1=1 --"]) {
      const client = new TestClient(ctx.app);
      client.setCookie('bos_session', value);
      const response = await client.get('/app/me');
      expect(response.statusCode).toBe(401);
    }
    const client = await signUp();
    const token = client.sessionCookie();
    const logout = await client.post('/app/auth/logout');
    expect(logout.statusCode).toBe(204);
    const replay = new TestClient(ctx.app);
    replay.setCookie('bos_session', token ?? '');
    const response = await replay.get('/app/me');
    expect(response.statusCode).toBe(401);
    expect(response.cookies.find((c) => c.name === 'bos_session')?.value).toBe('');
  });

  it('issues a new session on login and revokes the previous one (fixation)', async () => {
    const email = address('fixation');
    const client = await signUp(email);
    const first = client.sessionCookie();
    const second = await client.post('/app/auth/login', { email, password: TEST_PASSWORD });
    expect(second.statusCode).toBe(200);
    expect(client.sessionCookie()).not.toBe(first);
    const stale = new TestClient(ctx.app);
    stale.setCookie('bos_session', first ?? '');
    expect((await stale.get('/app/me')).statusCode).toBe(401);
  });

  it('revokes all sessions after a password reset', async () => {
    const email = address('reset');
    const client = await signUp(email);
    const anonymous = new TestClient(ctx.app);
    await anonymous.post('/app/auth/forgot-password', { email });
    const sent = ctx.mailer.lastTo(email);
    if (sent?.kind !== 'password_reset') throw new Error('missing reset email');
    const reset = await anonymous.post('/app/auth/reset-password', {
      token: tokenFromLink(sent.link),
      password: 'a fresh password 77',
    });
    expect(reset.statusCode).toBe(200);
    expect((await client.get('/app/me')).statusCode).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('blocks state-changing requests without an allowed origin', async () => {
    const client = await signUp();
    const noOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/app/orgs',
      payload: { name: 'X' },
      headers: { cookie: `bos_session=${client.sessionCookie() ?? ''}` },
    });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await client.post('/app/orgs', { name: 'X' }, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    const viaReferer = await ctx.app.inject({
      method: 'POST',
      url: '/app/orgs',
      payload: { name: 'Referer Org' },
      headers: {
        cookie: `bos_session=${client.sessionCookie() ?? ''}`,
        referer: `${TEST_ORIGIN}/onboarding`,
      },
    });
    expect(viaReferer.statusCode).toBe(201);
  });

  it('refuses non-JSON bodies (no simple cross-site form posts)', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/app/auth/login',
      payload: 'email=a@b.c&password=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_ORIGIN },
    });
    expect(response.statusCode).toBe(415);
  });
});

describe('organizations over HTTP', () => {
  it('creates, lists and switches organizations', async () => {
    const client = await signUp();
    const created = await client.post('/app/orgs', {
      name: 'Manama Motors',
      timezone: 'Asia/Bahrain',
    });
    expect(created.statusCode).toBe(201);
    const orgId = created.json().organization.id as string;
    expect(created.json().organization).toMatchObject({
      defaultCurrency: 'BHD',
      countryCode: 'BH',
    });

    const me = await client.get('/app/me');
    expect(me.json().activeOrganizationId).toBe(orgId);
    expect(me.json().organizations.map((o: { id: string }) => o.id)).toEqual([orgId]);

    const second = await client.post('/app/orgs', { name: 'Second Co' });
    const secondId = second.json().organization.id as string;
    const switched = await client.post('/app/me/active-organization', { organizationId: orgId });
    expect(switched.statusCode).toBe(204);
    expect((await client.get('/app/me')).json().activeOrganizationId).toBe(orgId);
    expect(secondId).not.toBe(orgId);
  });

  it('ignores privileged fields in creation payloads', async () => {
    const client = await signUp();
    const created = await client.post('/app/orgs', {
      name: 'Mass Assign',
      status: 'suspended',
      id: newId(),
      createdByUserId: world.orgB.users.owner.id,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().organization.status).toBe('active');
  });

  it('cannot switch to or read organizations the user does not belong to', async () => {
    const client = await loginAs(ctx, world.orgA.users.sales);
    const switchB = await client.post('/app/me/active-organization', {
      organizationId: world.orgB.organization.id,
    });
    expect(switchB.statusCode).toBe(404);

    const readB = await client.get(`/app/orgs/${world.orgB.organization.id}`);
    expect(readB.statusCode).toBe(404);
    const membersB = await client.get(`/app/orgs/${world.orgB.organization.id}/members`);
    expect(membersB.statusCode).toBe(404);
    const unknown = await client.get(`/app/orgs/${newId()}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: expect.objectContaining({ code: 'not_found', message: readB.json().error.message }),
    });
    const malformed = await client.get('/app/orgs/not-a-uuid/members');
    expect(malformed.statusCode).toBe(404);
  });

  it('serves tenant data only to members', async () => {
    const client = await loginAs(ctx, world.orgA.users.restricted);
    const org = await client.get(`/app/orgs/${world.orgA.organization.id}`);
    expect(org.statusCode).toBe(200);
    expect(org.json().organization.id).toBe(world.orgA.organization.id);
    const members = await client.get(`/app/orgs/${world.orgA.organization.id}/members?limit=2`);
    expect(members.statusCode).toBe(200);
    expect(members.json().data).toHaveLength(2);
    expect(members.json().nextCursor).toEqual(expect.any(String));
    const emails = (members.json().data as { email: string }[]).map((m) => m.email);
    expect(emails).not.toContain(world.orgB.users.owner.email);
  });

  it('denies access immediately when membership is suspended', async () => {
    const client = await loginAs(ctx, world.orgA.users.manager);
    expect((await client.get(`/app/orgs/${world.orgA.organization.id}`)).statusCode).toBe(200);
    const { memberships } = await import('@businessos/database');
    await withSystem(ctx.db.db, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'suspended' })
        .where(eq(memberships.userId, world.orgA.users.manager.id)),
    );
    expect((await client.get(`/app/orgs/${world.orgA.organization.id}`)).statusCode).toBe(404);
    await withSystem(ctx.db.db, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'active' })
        .where(eq(memberships.userId, world.orgA.users.manager.id)),
    );
  });
});

describe('invitations over HTTP', () => {
  async function invite(email: string) {
    return withTenant(
      ctx.db.db,
      { organizationId: world.orgA.organization.id, userId: world.orgA.users.owner.id },
      (tx) =>
        createInvitation(tx, ctx.app.deps.authConfig, {
          organizationId: world.orgA.organization.id,
          email,
          invitedByUserId: world.orgA.users.owner.id,
        }),
    );
  }

  it('lets an invited person create an account and land in the organization', async () => {
    const email = address('invited');
    const { token } = await invite(email);
    const client = new TestClient(ctx.app);
    const preview = await client.post('/app/invitations/preview', { token });
    expect(preview.json().invitation).toMatchObject({
      email,
      organizationName: world.orgA.organization.name,
      accountExists: false,
    });
    const joined = await client.post('/app/invitations/register', {
      token,
      name: 'New Hire',
      password: TEST_PASSWORD,
      email: 'attacker@example.com',
    });
    expect(joined.statusCode).toBe(201);
    const me = await client.get('/app/me');
    expect(me.json().user.email).toBe(email);
    expect(me.json().organizations.map((o: { id: string }) => o.id)).toEqual([
      world.orgA.organization.id,
    ]);
    const reuse = await new TestClient(ctx.app).post('/app/invitations/register', {
      token,
      name: 'Again',
      password: TEST_PASSWORD,
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('invalid_token');
  });

  it('requires the signed-in user to match the invited email', async () => {
    const { token } = await invite(address('someone'));
    const other = await signUp();
    const response = await other.post('/app/invitations/accept', { token });
    expect(response.statusCode).toBe(403);
  });
});

describe('session bookkeeping', () => {
  it('stores client metadata without the raw token', async () => {
    const client = await signUp();
    const token = client.sessionCookie() ?? '';
    const rows = await withSystem(ctx.db.db, (tx) => tx.select().from(sessions));
    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
  });
});
