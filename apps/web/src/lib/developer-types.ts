// Response shapes of `/app/orgs/:orgId/developers/*` (mirrors `@businessos/api-keys` and
// `@businessos/webhooks`).

export interface DeveloperOverview {
  /** Whether the organization's plan includes the API (keys, endpoints, test events). */
  enabled: boolean;
  apiBaseUrl: string;
  /** Scopes this member may give a key (they hold the matching permission). */
  scopes: { scope: string; label: string }[];
  eventTypes: string[];
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'active' | 'expired' | 'revoked';
  createdBy: { id: string; name: string } | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface WebhookEndpointSummary {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'active' | 'disabled';
  disabledReason: 'manual' | 'failing' | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliverySummary {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
