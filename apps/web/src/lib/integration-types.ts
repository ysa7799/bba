// Response shapes of `/app/orgs/:orgId/integrations/*` (mirrors `@businessos/integrations`).

export interface OAuthProviderInfo {
  key: string;
  label: string;
  /** False: the platform has no OAuth client for it yet (CONFIGURATION_REQUIRED). */
  configured: boolean;
}

export interface IntegrationAccountSummary {
  id: string;
  provider: string;
  providerLabel: string;
  status: 'connecting' | 'active' | 'refresh_required' | 'error' | 'disconnected';
  accountLabel: string;
  scopes: string[];
  connectedBy: { id: string; name: string } | null;
  lastRefreshedAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}
