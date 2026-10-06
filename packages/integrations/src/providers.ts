import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Tokens returned by a provider's token endpoint (refresh tokens are not always reissued). */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

/** Who authorized: the provider's stable account id and a recognisable label. */
export interface OAuthIdentity {
  externalAccountId: string;
  label: string;
}

/**
 * `invalid_grant`: the provider refused the code or refresh token for good (revoked, expired) —
 * the person must reconnect. `temporary`: outage, timeout or rate limit — try again later.
 * `rejected`: any other refusal (misconfiguration, invalid request).
 */
export type OAuthErrorKind = 'invalid_grant' | 'temporary' | 'rejected';

export class OAuthProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: OAuthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}

export interface AuthorizeRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: readonly string[];
}

export interface OAuthProvider {
  readonly key: string;
  readonly label: string;
  /** False when the platform has no OAuth client for it (CONFIGURATION_REQUIRED). */
  readonly configured: boolean;
  authorizeUrl(request: AuthorizeRequest): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ tokens: OAuthTokens; identity: OAuthIdentity }>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /** Best effort: tells the provider the grant is no longer wanted. */
  revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<void>;
}

export interface OAuthClientConfig {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}

type Fetch = typeof fetch;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().max(31_536_000).default(3600),
  scope: z.string().optional(),
});

const errorResponseSchema = z.object({ error: z.string().optional() }).loose();

interface StandardEndpoints {
  authorize: string;
  token: string;
  revoke?: string;
  /** Extra authorize parameters (e.g. Google's offline access). */
  authorizeParams?: Record<string, string>;
}

/**
 * Authorization-code flow with PKCE (S256) and a confidential client, the part every provider
 * shares. Identity lookup and revocation differ per provider.
 */
abstract class StandardOAuthProvider implements OAuthProvider {
  abstract readonly key: string;
  abstract readonly label: string;
  protected abstract readonly endpoints: StandardEndpoints;
  protected readonly fetchImpl: Fetch;

  constructor(
    protected readonly client: OAuthClientConfig,
    options: { fetch?: Fetch } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.client.clientId && this.client.clientSecret);
  }

  protected abstract identity(accessToken: string): Promise<OAuthIdentity>;

  authorizeUrl(request: AuthorizeRequest): string {
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.client.clientId ?? '',
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(' '),
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      ...this.endpoints.authorizeParams,
    }).toString();
    return url.toString();
  }

  protected async call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new OAuthProviderError(this.key, 'temporary', `${this.label} could not be reached`);
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) return body;
    if (response.status >= 500 || response.status === 429) {
      throw new OAuthProviderError(this.key, 'temporary', `${this.label} is unavailable right now`);
    }
    const code = errorResponseSchema.safeParse(body).data?.error;
    if (code === 'invalid_grant') {
      throw new OAuthProviderError(this.key, 'invalid_grant', `${this.label} access was revoked`);
    }
    throw new OAuthProviderError(
      this.key,
      'rejected',
      `${this.label} refused the request${code ? ` (${code.slice(0, 60)})` : ''}`,
    );
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const body = await this.call(this.endpoints.token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: this.client.clientId ?? '',
        client_secret: this.client.clientSecret ?? '',
        ...params,
      }).toString(),
    });
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthProviderError(this.key, 'rejected', `${this.label} sent an unexpected answer`);
    }
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresAt: new Date(Date.now() + parsed.data.expires_in * 1000),
      scopes: parsed.data.scope ? parsed.data.scope.split(/\s+/).filter(Boolean) : [],
    };
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    return { tokens, identity: await this.identity(tokens.accessToken) };
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(tokens: { accessToken: string; refreshToken: string | null }): Promise<void> {
    if (!this.endpoints.revoke) return;
    try {
      await this.call(this.endpoints.revoke, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }).toString(),
      });
    } catch {
      // Best effort: the grant is forgotten on our side either way.
    }
  }
}

const googleIdentitySchema = z.object({ sub: z.string().min(1), email: z.string().min(3) });

/** Google (OpenID Connect + Google APIs). Offline access gives a refresh token. */
export class GoogleOAuthProvider extends StandardOAuthProvider {
  readonly key = 'google';
  readonly label = 'Google';
  protected readonly endpoints: StandardEndpoints = {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };

  protected async identity(accessToken: string): Promise<OAuthIdentity> {
    const body = await this.call('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const parsed = googleIdentitySchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthProviderError(this.key, 'rejected', 'Google did not share the account email');
    }
    return { externalAccountId: parsed.data.sub, label: parsed.data.email };
  }
}

const microsoftIdentitySchema = z.object({
  id: z.string().min(1),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().min(1),
});

/** Microsoft identity platform (v2) + Microsoft Graph. Refresh tokens rotate on every use. */
export class MicrosoftOAuthProvider extends StandardOAuthProvider {
  readonly key = 'microsoft';
  readonly label = 'Microsoft 365';
  protected readonly endpoints: StandardEndpoints;

  constructor(client: OAuthClientConfig & { tenant?: string }, options: { fetch?: Fetch } = {}) {
    super(client, options);
    const tenant = encodeURIComponent(client.tenant ?? 'common');
    this.endpoints = {
      authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      authorizeParams: { response_mode: 'query', prompt: 'select_account' },
    };
  }

  protected async identity(accessToken: string): Promise<OAuthIdentity> {
    const body = await this.call('https://graph.microsoft.com/v1.0/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const parsed = microsoftIdentitySchema.safeParse(body);
    if (!parsed.success) {
      throw new OAuthProviderError(this.key, 'rejected', 'Microsoft did not share the account');
    }
    return {
      externalAccountId: parsed.data.id,
      label: parsed.data.mail ?? parsed.data.userPrincipalName,
    };
  }
}

/**
 * Development and tests only: an OAuth "provider" that runs inside BusinessOS. Its consent page
 * is `/dev/fake-oauth` in the web app, its codes describe the account they stand for, and a
 * refresh token containing `revoked` is refused (to exercise reconnection).
 */
export class FakeOAuthProvider implements OAuthProvider {
  readonly key = 'fake_oauth';
  readonly label = 'Test account (development)';
  readonly configured = true;

  constructor(private readonly appUrl: string) {}

  authorizeUrl(request: AuthorizeRequest): string {
    const url = new URL('/dev/fake-oauth', this.appUrl);
    url.search = new URLSearchParams({
      state: request.state,
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(' '),
      code_challenge: request.codeChallenge,
    }).toString();
    return url.toString();
  }

  exchangeCode(input: { code: string }): Promise<{ tokens: OAuthTokens; identity: OAuthIdentity }> {
    const email = /^fake\.([^\s]{3,200})$/.exec(input.code)?.[1];
    if (!email) {
      return Promise.reject(new OAuthProviderError(this.key, 'invalid_grant', 'Unknown code'));
    }
    return Promise.resolve({
      tokens: this.issue(`fake-refresh-${randomBytes(12).toString('hex')}`),
      identity: { externalAccountId: `fake:${email}`, label: email },
    });
  }

  refresh(refreshToken: string): Promise<OAuthTokens> {
    if (refreshToken.includes('revoked')) {
      return Promise.reject(
        new OAuthProviderError(this.key, 'invalid_grant', 'Test account access was revoked'),
      );
    }
    if (refreshToken.includes('outage')) {
      return Promise.reject(
        new OAuthProviderError(this.key, 'temporary', 'Test account is unavailable right now'),
      );
    }
    return Promise.resolve(this.issue(null));
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }

  private issue(refreshToken: string | null): OAuthTokens {
    return {
      accessToken: `fake-access-${randomBytes(12).toString('hex')}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['calendar'],
    };
  }
}

export class OAuthProviderRegistry {
  private readonly providers = new Map<string, OAuthProvider>();

  constructor(providers: readonly OAuthProvider[] = []) {
    for (const provider of providers) this.providers.set(provider.key, provider);
  }

  get(key: string): OAuthProvider | undefined {
    return this.providers.get(key);
  }

  list(): OAuthProvider[] {
    return [...this.providers.values()];
  }
}

export interface OAuthEnvironment {
  appUrl: string;
  google?: OAuthClientConfig;
  microsoft?: OAuthClientConfig & { tenant?: string };
  /** Development and tests only. */
  fake?: boolean;
}

/** Google and Microsoft always (CONFIGURATION_REQUIRED without a client), plus the fake. */
export function createOAuthProviders(env: OAuthEnvironment): OAuthProviderRegistry {
  const providers: OAuthProvider[] = [
    new GoogleOAuthProvider(env.google ?? {}),
    new MicrosoftOAuthProvider(env.microsoft ?? {}),
  ];
  if (env.fake) providers.push(new FakeOAuthProvider(env.appUrl));
  return new OAuthProviderRegistry(providers);
}
