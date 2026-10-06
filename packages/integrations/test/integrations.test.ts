import {
  integrationAccounts,
  integrationOauthStates,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SecretBox,
  ValidationError,
} from '@businessos/shared';
import {
  createTestDatabase,
  createTestUser,
  createTestWorld,
  type TestWorld,
} from '@businessos/testing';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  completeAuthorization,
  disconnectAccount,
  getAccessToken,
  GoogleOAuthProvider,
  IntegrationReconnectRequired,
  IntegrationTemporarilyUnavailable,
  listAccounts,
  MicrosoftOAuthProvider,
  OAuthProviderError,
  OAuthProviderRegistry,
  runIntegrationMaintenance,
  startAuthorization,
  type IntegrationServices,
  type OAuthProvider,
  type OAuthTokens,
} from '../src';

/** A provider the test controls: what it answers and how often it was asked. */
class TestProvider implements OAuthProvider {
  readonly key = 'fake_oauth';
  readonly label = 'Test provider';
  configured = true;
  refreshCalls = 0;
  revoked: string[] = [];
  nextRefresh: 'ok' | 'revoked' | 'outage' = 'ok';
  /** Identity per code (`code-<email>`). */
  authorizeUrl(request: { state: string; codeChallenge: string; redirectUri: string }) {
    return `https://provider.example/authorize?state=${request.state}&code_challenge=${request.codeChallenge}`;
  }
  exchangeCode(input: { code: string; codeVerifier: string }) {
    lastVerifier = input.codeVerifier;
    const email = input.code.replace(/^code-/, '');
    return Promise.resolve({
      tokens: tokens('refresh-1'),
      identity: { externalAccountId: `id-${email}`, label: email },
    });
  }
  async refresh(): Promise<OAuthTokens> {
    this.refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (this.nextRefresh === 'revoked') {
      throw new OAuthProviderError(this.key, 'invalid_grant', 'Access was revoked');
    }
    if (this.nextRefresh === 'outage') {
      throw new OAuthProviderError(this.key, 'temporary', 'Provider unavailable');
    }
    return tokens(null);
  }
  revoke(input: { accessToken: string; refreshToken: string | null }) {
    this.revoked.push(input.refreshToken ?? input.accessToken);
    return Promise.resolve();
  }
}

let lastVerifier = '';
let counter = 0;
function tokens(refreshToken: string | null, expiresInMs = 3_600_000): OAuthTokens {
  counter += 1;
  return {
    accessToken: `access-${counter}`,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresInMs),
    scopes: ['calendar'],
  };
}

let handle: DatabaseHandle;
let world: TestWorld;
const provider = new TestProvider();
let services: IntegrationServices;

beforeAll(async () => {
  handle = createTestDatabase(6);
  world = await createTestWorld(handle.db);
  services = {
    db: handle.db,
    secretBox: new SecretBox([{ id: 't', key: Buffer.alloc(32, 4) }]),
    providers: new OAuthProviderRegistry([provider]),
    redirectUri: 'https://app.example.com/oauth/callback',
  };
});

afterAll(async () => {
  await handle.close();
});

const A = () => world.orgA.organization.id;
const B = () => world.orgB.organization.id;

async function connect(email: string, user = world.orgA.users.manager, org = A()) {
  const { authorizeUrl } = await startAuthorization(
    services,
    { organizationId: org, userId: user.id },
    { provider: 'fake_oauth', purpose: 'calendar', context: { calendarId: 'c' } },
  );
  const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
  return {
    state,
    result: () => completeAuthorization(services, user.id, { state, code: `code-${email}` }),
  };
}

async function accountRow(id: string) {
  const [row] = await withSystem(handle.db, (tx) =>
    tx.select().from(integrationAccounts).where(eq(integrationAccounts.id, id)),
  );
  return row;
}

describe('provider adapters', () => {
  it('builds a PKCE authorization request and exchanges codes (Google)', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const target = url instanceof Request ? url.url : url.toString();
      calls.push({ url: target, body: typeof init?.body === 'string' ? init.body : '' });
      const body = target.includes('userinfo')
        ? { sub: 'g-1', email: 'host@example.com' }
        : { access_token: 'ya29.x', refresh_token: 'r-1', expires_in: 3599, scope: 'openid email' };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    const google = new GoogleOAuthProvider(
      { clientId: 'client-1', clientSecret: 'secret-1' },
      { fetch: fetchMock },
    );
    const url = new URL(
      google.authorizeUrl({
        state: 's',
        codeChallenge: 'c',
        redirectUri: 'https://app.example.com/oauth/callback',
        scopes: ['openid', 'email'],
      }),
    );
    expect(url.origin).toBe('https://accounts.google.com');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      access_type: 'offline',
      scope: 'openid email',
    });
    expect(url.searchParams.has('client_secret')).toBe(false);

    const exchanged = await google.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example.com/oauth/callback',
    });
    expect(exchanged.identity).toEqual({ externalAccountId: 'g-1', label: 'host@example.com' });
    expect(exchanged.tokens).toMatchObject({ accessToken: 'ya29.x', refreshToken: 'r-1' });
    const form = new URLSearchParams(calls[0]?.body);
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: 'verifier',
      client_secret: 'secret-1',
    });
  });

  it('separates revoked grants from outages', async () => {
    const answer = (status: number, body: unknown) =>
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    const revoked = new MicrosoftOAuthProvider(
      { clientId: 'a', clientSecret: 'b' },
      { fetch: answer(400, { error: 'invalid_grant' }) },
    );
    await expect(revoked.refresh('r')).rejects.toMatchObject({ kind: 'invalid_grant' });
    const down = new MicrosoftOAuthProvider(
      { clientId: 'a', clientSecret: 'b' },
      { fetch: answer(503, {}) },
    );
    await expect(down.refresh('r')).rejects.toMatchObject({ kind: 'temporary' });
    // Without a platform client the provider is not offered.
    expect(new GoogleOAuthProvider({}).configured).toBe(false);
  });
});

describe('authorization', () => {
  it('stores only a hash of the state and a sealed PKCE verifier', async () => {
    const { state, result } = await connect('first@example.com');
    const [stored] = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(integrationOauthStates)
        .where(
          eq(integrationOauthStates.stateHash, createHash('sha256').update(state).digest('hex')),
        ),
    );
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(state);
    const completed = await result();
    // The verifier the provider received matches the challenge sent at the start.
    expect(stored?.codeVerifierSealed).not.toContain(lastVerifier);
    expect(completed).toMatchObject({
      organizationId: A(),
      purpose: 'calendar',
      context: { calendarId: 'c' },
      account: { status: 'active', accountLabel: 'first@example.com', provider: 'fake_oauth' },
    });
    const row = await accountRow(completed.account.id);
    expect(row?.tokensSealed).toBeTruthy();
    expect(row?.tokensSealed).not.toContain('refresh-1');
  });

  it('refuses reused, expired, foreign and abandoned authorizations', async () => {
    const first = await connect('reuse@example.com');
    await first.result();
    await expect(first.result()).rejects.toBeInstanceOf(ValidationError);

    // Someone else completing it (e.g. a forwarded link) never attaches it to them.
    const second = await connect('stolen@example.com');
    await expect(
      completeAuthorization(services, world.orgA.users.sales.id, {
        state: second.state,
        code: 'code-stolen@example.com',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const third = await connect('late@example.com');
    await expect(
      completeAuthorization(
        services,
        world.orgA.users.manager.id,
        { state: third.state, code: 'code-late@example.com' },
        new Date(Date.now() + 11 * 60_000),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const denied = await connect('denied@example.com');
    await expect(
      completeAuthorization(services, world.orgA.users.manager.id, {
        state: denied.state,
        error: 'access_denied',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    provider.configured = false;
    await expect(connect('off@example.com')).rejects.toBeInstanceOf(ConflictError);
    provider.configured = true;
  });

  it('updates a member’s own account on reconnect and refuses someone else’s', async () => {
    const first = await (await connect('shared@example.com')).result();
    const again = await (await connect('shared@example.com')).result();
    expect(again.account.id).toBe(first.account.id);
    const other = await connect('shared@example.com', world.orgA.users.owner);
    await expect(other.result()).rejects.toBeInstanceOf(ConflictError);

    // A member who left cannot finish a connection they started.
    const leaver = await createTestUser(handle.db, { name: 'Leaver' });
    const { addTestMember } = await import('@businessos/testing');
    await addTestMember(handle.db, A(), leaver.id);
    const pending = await connect('leaver@example.com', leaver);
    const { memberships } = await import('@businessos/database');
    const { and } = await import('drizzle-orm');
    await withSystem(handle.db, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'suspended' })
        .where(and(eq(memberships.userId, leaver.id), eq(memberships.organizationId, A()))),
    );
    await expect(pending.result()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('tokens', () => {
  it('reuses fresh tokens and refreshes expiring ones once, even concurrently', async () => {
    const { account } = await (await connect('tokens@example.com')).result();
    const before = provider.refreshCalls;
    const token = await getAccessToken(services, A(), account.id);
    expect(token).toMatch(/^access-/);
    expect(provider.refreshCalls).toBe(before);

    await withSystem(handle.db, (tx) =>
      tx
        .update(integrationAccounts)
        .set({ accessTokenExpiresAt: new Date(Date.now() + 30_000) })
        .where(eq(integrationAccounts.id, account.id)),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getAccessToken(services, A(), account.id)),
    );
    expect(provider.refreshCalls).toBe(before + 1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBe(token);
    // The refresh token was not reissued: the original one is kept.
    const row = await accountRow(account.id);
    const sealed = services.secretBox?.decrypt(
      row?.tokensSealed ?? '',
      `integration_account:${A()}:${account.id}`,
    );
    expect(JSON.parse(sealed ?? '{}')).toMatchObject({ refreshToken: 'refresh-1' });
  });

  it('marks revoked grants for reconnection and outages as temporary', async () => {
    const { account } = await (await connect('fragile@example.com')).result();
    const expire = () =>
      withSystem(handle.db, (tx) =>
        tx
          .update(integrationAccounts)
          .set({ accessTokenExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(integrationAccounts.id, account.id)),
      );
    await expire();
    provider.nextRefresh = 'outage';
    await expect(getAccessToken(services, A(), account.id)).rejects.toBeInstanceOf(
      IntegrationTemporarilyUnavailable,
    );
    expect(await accountRow(account.id)).toMatchObject({ status: 'error', consecutiveFailures: 1 });
    // It recovers by itself once the provider is back.
    provider.nextRefresh = 'ok';
    await getAccessToken(services, A(), account.id);
    expect(await accountRow(account.id)).toMatchObject({
      status: 'active',
      consecutiveFailures: 0,
    });

    await expire();
    provider.nextRefresh = 'revoked';
    await expect(getAccessToken(services, A(), account.id)).rejects.toBeInstanceOf(
      IntegrationReconnectRequired,
    );
    expect((await accountRow(account.id))?.status).toBe('refresh_required');
    provider.nextRefresh = 'ok';
    // Stays refused until the member reconnects (no retry storm against the provider).
    const calls = provider.refreshCalls;
    await expect(getAccessToken(services, A(), account.id)).rejects.toBeInstanceOf(
      IntegrationReconnectRequired,
    );
    expect(provider.refreshCalls).toBe(calls);
    const reconnected = await (await connect('fragile@example.com')).result();
    expect(reconnected.account).toMatchObject({ id: account.id, status: 'active' });
  });

  it('keeps accounts inside their organization and erases tokens on disconnect', async () => {
    const { account } = await (await connect('private@example.com')).result();
    const inB = { organizationId: B(), userId: world.orgB.users.owner.id };
    const listed = await withTenant(handle.db, inB, (tx) => listAccounts(tx, services, B()));
    expect(listed.some((entry) => entry.id === account.id)).toBe(false);
    await expect(getAccessToken(services, B(), account.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withTenant(handle.db, inB, (tx) => disconnectAccount(services, tx, A(), account.id)),
    ).rejects.toBeInstanceOf(NotFoundError);

    const mine = await withTenant(
      handle.db,
      { organizationId: A(), userId: world.orgA.users.sales.id },
      (tx) => listAccounts(tx, services, A(), { onlyUserId: world.orgA.users.sales.id }),
    );
    expect(mine.some((entry) => entry.id === account.id)).toBe(false);

    const { revoke } = await withTenant(
      handle.db,
      { organizationId: A(), userId: world.orgA.users.manager.id },
      (tx) => disconnectAccount(services, tx, A(), account.id),
    );
    await revoke();
    expect(provider.revoked).toContain('refresh-1');
    expect(await accountRow(account.id)).toMatchObject({
      status: 'disconnected',
      tokensSealed: null,
    });
    await expect(getAccessToken(services, A(), account.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refreshes due accounts and clears old states in maintenance', async () => {
    const { account } = await (await connect('due@example.com')).result();
    await withSystem(handle.db, (tx) =>
      tx
        .update(integrationAccounts)
        .set({ accessTokenExpiresAt: new Date(Date.now() + 5 * 60_000) })
        .where(eq(integrationAccounts.id, account.id)),
    );
    const before = (await accountRow(account.id))?.lastRefreshedAt?.getTime() ?? 0;
    const result = await runIntegrationMaintenance(services, new Date(Date.now() + 4 * 60_000));
    expect(result.refreshed).toBeGreaterThanOrEqual(1);
    expect((await accountRow(account.id))?.lastRefreshedAt?.getTime()).toBeGreaterThan(before);
    const cleaned = await runIntegrationMaintenance(
      services,
      new Date(Date.now() + 2 * 86_400_000),
    );
    expect(cleaned.statesRemoved).toBeGreaterThanOrEqual(1);
  });
});
