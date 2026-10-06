import {
  integrationAccounts,
  integrationOauthStates,
  users,
  withSystem,
  withTenant,
  type Database,
  type IntegrationAccount,
  type TenantTx,
} from '@businessos/database';
import {
  ConflictError,
  ForbiddenError,
  newId,
  NotFoundError,
  ValidationError,
  type SecretBox,
} from '@businessos/shared';
import { resolveMembership } from '@businessos/organizations';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OAuthProviderError, type OAuthProviderRegistry, type OAuthTokens } from './providers';

/** Authorizations not completed within this time are refused. */
export const STATE_TTL_MS = 10 * 60_000;
/** Access tokens are refreshed this long before they expire. */
export const REFRESH_MARGIN_MS = 2 * 60_000;
const LAST_USED_RESOLUTION_MS = 60_000;

/** What each purpose asks each provider for. */
export const PURPOSE_SCOPES: Record<string, Record<string, readonly string[]>> = {
  calendar: {
    google: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
    microsoft: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite'],
    fake_oauth: ['calendar'],
  },
};

export interface IntegrationServices {
  db: Database;
  secretBox: SecretBox | null;
  providers: OAuthProviderRegistry;
  /** Where providers send people back (`APP_URL/oauth/callback`, registered with them). */
  redirectUri: string;
}

/** The account needs its owner to reconnect (revoked or expired grant). */
export class IntegrationReconnectRequired extends Error {
  /** Waiting does not help: the person must reconnect. */
  readonly retryable = false;

  constructor(readonly accountId: string) {
    super('The connected account must be reconnected');
    this.name = 'IntegrationReconnectRequired';
  }
}

/** The provider could not be reached; try again later. */
export class IntegrationTemporarilyUnavailable extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'IntegrationTemporarilyUnavailable';
  }
}

interface SealedTokens {
  accessToken: string;
  refreshToken: string | null;
}

const sealedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
});

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenContext = (organizationId: string, accountId: string) =>
  `integration_account:${organizationId}:${accountId}`;
const verifierContext = (organizationId: string, stateId: string) =>
  `oauth_state:${organizationId}:${stateId}`;

function requireBox(services: IntegrationServices): SecretBox {
  if (!services.secretBox) throw new ConflictError('Credential encryption is not configured');
  return services.secretBox;
}

function seal(services: IntegrationServices, account: IntegrationAccount, tokens: SealedTokens) {
  return requireBox(services).encrypt(
    JSON.stringify(tokens),
    tokenContext(account.organizationId, account.id),
  );
}

function unseal(services: IntegrationServices, account: IntegrationAccount): SealedTokens {
  if (!account.tokensSealed) throw new IntegrationReconnectRequired(account.id);
  return sealedTokensSchema.parse(
    JSON.parse(
      requireBox(services).decrypt(
        account.tokensSealed,
        tokenContext(account.organizationId, account.id),
      ),
    ),
  );
}

function clip(message: string): string {
  return message.length > 500 ? `${message.slice(0, 499)}…` : message;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────

export interface IntegrationAccountView {
  id: string;
  provider: string;
  providerLabel: string;
  status: IntegrationAccount['status'];
  accountLabel: string;
  scopes: string[];
  connectedBy: { id: string; name: string } | null;
  lastRefreshedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

async function views(
  tx: TenantTx,
  services: Pick<IntegrationServices, 'providers'>,
  rows: IntegrationAccount[],
): Promise<IntegrationAccountView[]> {
  const ids = [
    ...new Set(rows.map((row) => row.connectedByUserId).filter((id): id is string => id !== null)),
  ];
  const people =
    ids.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, ids));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerLabel: services.providers.get(row.provider)?.label ?? row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    scopes: row.scopes,
    connectedBy: people.find((person) => person.id === row.connectedByUserId) ?? null,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface ProviderView {
  key: string;
  label: string;
  /** False: the platform has no OAuth client for it (CONFIGURATION_REQUIRED). */
  configured: boolean;
}

export function listProviders(services: Pick<IntegrationServices, 'providers'>): ProviderView[] {
  return services.providers.list().map((provider) => ({
    key: provider.key,
    label: provider.label,
    configured: provider.configured,
  }));
}

/** Accounts of the organization; `onlyUserId` limits them to one member's own. */
export async function listAccounts(
  tx: TenantTx,
  services: Pick<IntegrationServices, 'providers'>,
  organizationId: string,
  options: { onlyUserId?: string } = {},
): Promise<IntegrationAccountView[]> {
  const rows = await tx
    .select()
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.organizationId, organizationId),
        sql`${integrationAccounts.status} <> 'disconnected'`,
        options.onlyUserId
          ? eq(integrationAccounts.connectedByUserId, options.onlyUserId)
          : undefined,
      ),
    )
    .orderBy(desc(integrationAccounts.createdAt), desc(integrationAccounts.id))
    .limit(100);
  return views(tx, services, rows);
}

export async function getAccountRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<IntegrationAccount> {
  const [row] = await tx
    .select()
    .from(integrationAccounts)
    .where(
      and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, id)),
    );
  if (!row || row.status === 'disconnected') throw new NotFoundError('Connected account');
  return row;
}

// ── Authorization ───────────────────────────────────────────────────────────────────────────

export const startAuthorizationInputSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  purpose: z.string().regex(/^[a-z_]{1,40}$/),
  context: z.record(z.string().max(60), z.string().max(200)).default({}),
});
export type StartAuthorizationInput = z.input<typeof startAuthorizationInputSchema>;

/**
 * Starts an OAuth authorization for a member: records the state (hashed) and the PKCE verifier
 * (sealed) and returns the provider's consent URL. The caller has already checked the member may
 * use the purpose (e.g. edit that calendar).
 */
export async function startAuthorization(
  services: IntegrationServices,
  scope: { organizationId: string; userId: string },
  rawInput: StartAuthorizationInput,
  now: Date = new Date(),
): Promise<{ authorizeUrl: string }> {
  const input = startAuthorizationInputSchema.parse(rawInput);
  const provider = services.providers.get(input.provider);
  const scopes = PURPOSE_SCOPES[input.purpose]?.[input.provider];
  if (!provider || !scopes) {
    throw new ValidationError('Unknown provider', [{ path: 'provider', message: 'Not supported' }]);
  }
  if (!provider.configured) {
    throw new ConflictError(
      `${provider.label} is not set up on this server yet (CONFIGURATION_REQUIRED)`,
    );
  }
  const box = requireBox(services);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const id = newId();
  await withTenant(services.db, scope, (tx) =>
    tx.insert(integrationOauthStates).values({
      id,
      organizationId: scope.organizationId,
      userId: scope.userId,
      provider: provider.key,
      purpose: input.purpose,
      stateHash: hash(state),
      codeVerifierSealed: box.encrypt(codeVerifier, verifierContext(scope.organizationId, id)),
      context: input.context,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    }),
  );
  return {
    authorizeUrl: provider.authorizeUrl({
      state,
      codeChallenge,
      redirectUri: services.redirectUri,
      scopes,
    }),
  };
}

export const completeAuthorizationInputSchema = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(1).max(4_000).optional(),
  /** The provider's refusal (`access_denied` when the person said no). */
  error: z.string().max(200).optional(),
});

export interface CompletedAuthorization {
  organizationId: string;
  purpose: string;
  context: Record<string, string>;
  account: IntegrationAccountView;
}

/**
 * Finishes an authorization when the provider sends the person back: the state must exist, be
 * unexpired, unused and belong to the same signed-in person. The code is exchanged (with the
 * PKCE verifier) and the account is created, or updated if this person connected it before.
 */
export async function completeAuthorization(
  services: IntegrationServices,
  userId: string,
  rawInput: z.input<typeof completeAuthorizationInputSchema>,
  now: Date = new Date(),
): Promise<CompletedAuthorization> {
  const input = completeAuthorizationInputSchema.parse(rawInput);
  // System scope: the state is what identifies the organization on return (like a token
  // lookup); it is matched by the hash of a 256-bit value and consumed exactly once.
  const [state] = await withSystem(services.db, (tx) =>
    tx
      .update(integrationOauthStates)
      .set({ consumedAt: now })
      .where(
        and(
          eq(integrationOauthStates.stateHash, hash(input.state)),
          isNull(integrationOauthStates.consumedAt),
        ),
      )
      .returning(),
  );
  if (!state || state.expiresAt <= now) {
    throw new ValidationError('This connection link has expired. Please start again.', [
      { path: 'state', message: 'Expired or already used' },
    ]);
  }
  if (state.userId !== userId) {
    // Someone else's authorization (e.g. a forwarded link): never attach it to this person.
    throw new ForbiddenError('This connection was started by someone else');
  }
  // Still a member of the organization the connection was started in.
  if (!(await resolveMembership(services.db, userId, state.organizationId))) {
    throw new ForbiddenError('You are no longer a member of this organization');
  }
  if (input.error || !input.code) {
    throw new ValidationError('The connection was cancelled', [
      { path: 'code', message: input.error ?? 'No authorization code' },
    ]);
  }
  const provider = services.providers.get(state.provider);
  if (!provider) throw new ConflictError('This provider is no longer available');
  const box = requireBox(services);
  const codeVerifier = box.decrypt(
    state.codeVerifierSealed,
    verifierContext(state.organizationId, state.id),
  );
  let exchanged;
  try {
    exchanged = await provider.exchangeCode({
      code: input.code,
      codeVerifier,
      redirectUri: services.redirectUri,
    });
  } catch (error) {
    if (error instanceof OAuthProviderError && error.kind === 'temporary') {
      throw new IntegrationTemporarilyUnavailable(error.message);
    }
    throw new ValidationError('The provider did not accept the connection. Please try again.', [
      { path: 'code', message: error instanceof Error ? error.message : 'Refused' },
    ]);
  }
  const { tokens, identity } = exchanged;
  const scope = { organizationId: state.organizationId, userId };
  const account = await withTenant(services.db, scope, async (tx) => {
    const [existing] = await tx
      .select()
      .from(integrationAccounts)
      .where(
        and(
          eq(integrationAccounts.organizationId, state.organizationId),
          eq(integrationAccounts.provider, provider.key),
          eq(integrationAccounts.externalAccountId, identity.externalAccountId),
          sql`${integrationAccounts.status} <> 'disconnected'`,
        ),
      )
      .for('update');
    if (existing && existing.connectedByUserId !== userId) {
      throw new ConflictError(
        `${identity.label} is already connected by another member of this organization`,
      );
    }
    const id = existing?.id ?? newId();
    const base = { id, organizationId: state.organizationId } as IntegrationAccount;
    const previous = existing ? unseal(services, existing) : null;
    const sealed = seal(services, base, {
      accessToken: tokens.accessToken,
      // Providers may only send a refresh token the first time.
      refreshToken: tokens.refreshToken ?? previous?.refreshToken ?? null,
    });
    const values = {
      status: 'active' as const,
      accountLabel: identity.label.slice(0, 320),
      scopes: tokens.scopes,
      tokensSealed: sealed,
      accessTokenExpiresAt: tokens.expiresAt,
      lastRefreshedAt: now,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };
    const [row] = existing
      ? await tx
          .update(integrationAccounts)
          .set(values)
          .where(eq(integrationAccounts.id, existing.id))
          .returning()
      : await tx
          .insert(integrationAccounts)
          .values({
            ...values,
            id,
            organizationId: state.organizationId,
            provider: provider.key,
            externalAccountId: identity.externalAccountId,
            connectedByUserId: userId,
          })
          .returning();
    if (!row) throw new Error('Connected account was not saved');
    const [view] = await views(tx, services, [row]);
    if (!view) throw new Error('Connected account was not saved');
    return view;
  });
  return {
    organizationId: state.organizationId,
    purpose: state.purpose,
    context: z.record(z.string(), z.string()).parse(state.context),
    account,
  };
}

// ── Tokens ──────────────────────────────────────────────────────────────────────────────────

type RefreshOutcome =
  | { kind: 'token'; accessToken: string }
  | { kind: 'reconnect' }
  | { kind: 'unavailable'; message: string };

/**
 * A usable access token for the account, refreshed when it is about to expire. Refreshes are
 * serialized per account (providers that rotate refresh tokens invalidate the old one).
 * Throws `IntegrationReconnectRequired` when the grant is gone and
 * `IntegrationTemporarilyUnavailable` when the provider cannot be reached.
 */
export async function getAccessToken(
  services: IntegrationServices,
  organizationId: string,
  accountId: string,
  now: Date = new Date(),
): Promise<string> {
  const scope = { organizationId, userId: null };
  const outcome = await withTenant(services.db, scope, async (tx): Promise<RefreshOutcome> => {
    const row = await getAccountRow(tx, organizationId, accountId);
    if (row.status === 'refresh_required') return { kind: 'reconnect' };
    const fresh =
      row.accessTokenExpiresAt &&
      row.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime();
    if (fresh && row.status === 'active') {
      if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
        await tx
          .update(integrationAccounts)
          .set({ lastUsedAt: now })
          .where(eq(integrationAccounts.id, row.id));
      }
      return { kind: 'token', accessToken: unseal(services, row).accessToken };
    }
    // One refresh at a time per account; whoever waited reuses the result.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`integration_account:${row.id}`}, 0))`,
    );
    const current = await getAccountRow(tx, organizationId, accountId);
    if (current.status === 'refresh_required') return { kind: 'reconnect' };
    if (
      current.status === 'active' &&
      current.accessTokenExpiresAt &&
      current.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()
    ) {
      return { kind: 'token', accessToken: unseal(services, current).accessToken };
    }
    const sealed = unseal(services, current);
    const provider = services.providers.get(current.provider);
    if (!provider || !sealed.refreshToken) {
      await tx
        .update(integrationAccounts)
        .set({
          status: 'refresh_required',
          lastError: provider ? 'No refresh token was granted' : 'Provider no longer available',
          lastErrorAt: now,
          updatedAt: now,
        })
        .where(eq(integrationAccounts.id, current.id));
      return { kind: 'reconnect' };
    }
    let tokens: OAuthTokens;
    try {
      tokens = await provider.refresh(sealed.refreshToken);
    } catch (error) {
      const permanent = error instanceof OAuthProviderError && error.kind !== 'temporary';
      const message = clip(error instanceof Error ? error.message : 'Refresh failed');
      await tx
        .update(integrationAccounts)
        .set({
          status: permanent ? 'refresh_required' : 'error',
          lastError: message,
          lastErrorAt: now,
          consecutiveFailures: sql`${integrationAccounts.consecutiveFailures} + 1`,
          updatedAt: now,
        })
        .where(eq(integrationAccounts.id, current.id));
      return permanent ? { kind: 'reconnect' } : { kind: 'unavailable', message };
    }
    await tx
      .update(integrationAccounts)
      .set({
        status: 'active',
        tokensSealed: seal(services, current, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? sealed.refreshToken,
        }),
        accessTokenExpiresAt: tokens.expiresAt,
        ...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
        lastRefreshedAt: now,
        lastUsedAt: now,
        lastError: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(integrationAccounts.id, current.id));
    return { kind: 'token', accessToken: tokens.accessToken };
  });
  if (outcome.kind === 'reconnect') throw new IntegrationReconnectRequired(accountId);
  if (outcome.kind === 'unavailable') throw new IntegrationTemporarilyUnavailable(outcome.message);
  return outcome.accessToken;
}

/**
 * Disconnects an account: tokens are erased, the provider is asked to revoke the grant (best
 * effort) and `onDisconnect` lets features that used it stop (e.g. calendar connections).
 */
export async function disconnectAccount(
  services: IntegrationServices,
  tx: TenantTx,
  organizationId: string,
  id: string,
  now: Date = new Date(),
): Promise<{ account: IntegrationAccountView; revoke: () => Promise<void> }> {
  const row = await getAccountRow(tx, organizationId, id);
  let tokens: SealedTokens | null = null;
  try {
    tokens = unseal(services, row);
  } catch {
    tokens = null;
  }
  const [updated] = await tx
    .update(integrationAccounts)
    .set({
      status: 'disconnected',
      tokensSealed: null,
      accessTokenExpiresAt: null,
      disconnectedAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.id, id)),
    )
    .returning();
  if (!updated) throw new NotFoundError('Connected account');
  const [account] = await views(tx, services, [updated]);
  if (!account) throw new NotFoundError('Connected account');
  const provider = services.providers.get(row.provider);
  return {
    account,
    // Called after commit: a slow provider never holds the transaction open.
    revoke: async () => {
      if (provider && tokens) await provider.revoke(tokens);
    },
  };
}

/**
 * Upkeep (worker): refreshes tokens about to expire (so revoked grants surface within the hour,
 * not when someone books) and removes old authorization states.
 */
export async function runIntegrationMaintenance(
  services: IntegrationServices,
  now: Date = new Date(),
): Promise<{ refreshed: number; failed: number; statesRemoved: number }> {
  // System scope: upkeep spans organizations; each account is then handled in its own scope.
  const due = await withSystem(services.db, (tx) =>
    tx
      .select({ id: integrationAccounts.id, organizationId: integrationAccounts.organizationId })
      .from(integrationAccounts)
      .where(
        and(
          or(eq(integrationAccounts.status, 'active'), eq(integrationAccounts.status, 'error')),
          lt(integrationAccounts.accessTokenExpiresAt, new Date(now.getTime() + 15 * 60_000)),
        ),
      )
      .limit(200),
  );
  let refreshed = 0;
  let failed = 0;
  for (const account of due) {
    try {
      await getAccessToken(services, account.organizationId, account.id, now);
      refreshed += 1;
    } catch {
      failed += 1;
    }
  }
  // System scope: see above.
  const removed = await withSystem(services.db, (tx) =>
    tx
      .delete(integrationOauthStates)
      .where(lt(integrationOauthStates.expiresAt, new Date(now.getTime() - 86_400_000)))
      .returning({ id: integrationOauthStates.id }),
  );
  return { refreshed, failed, statesRemoved: removed.length };
}
