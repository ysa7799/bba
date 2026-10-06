import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { organizations } from './organizations';
import { users } from './users';

const orgId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

/**
 * `connecting → active → (refresh_required | error) → active | disconnected`.
 * `refresh_required`: the provider refused the refresh token (revoked or expired grant); only
 * the person reconnecting can fix it. `error`: temporary failures (provider outage).
 */
export const INTEGRATION_ACCOUNT_STATUSES = [
  'connecting',
  'active',
  'refresh_required',
  'error',
  'disconnected',
] as const;
export type IntegrationAccountStatus = (typeof INTEGRATION_ACCOUNT_STATUSES)[number];

/**
 * An account at an external provider (Google, Microsoft…) authorized through OAuth by a member
 * for their organization. Tokens are sealed with the platform key (associated data binds them to
 * the organization and account) and only ever decrypted server-side.
 */
export const integrationAccounts = pgTable(
  'integration_accounts',
  {
    id: primaryId(),
    organizationId: orgId(),
    provider: text().notNull(),
    status: text({ enum: INTEGRATION_ACCOUNT_STATUSES }).notNull().default('connecting'),
    /** The provider's stable id for the account (e.g. OpenID `sub`). */
    externalAccountId: text().notNull(),
    /** What people recognise (usually the email address). */
    accountLabel: text().notNull(),
    scopes: text().array().notNull(),
    tokensSealed: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    connectedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastRefreshedAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    lastErrorAt: timestamp({ withTimezone: true }),
    consecutiveFailures: integer().notNull().default(0),
    disconnectedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('integration_accounts_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('integration_accounts_external_unique')
      .on(t.organizationId, t.provider, t.externalAccountId)
      .where(sql`${t.status} <> 'disconnected'`),
    index('integration_accounts_org_idx').on(t.organizationId, t.createdAt.desc()),
    index('integration_accounts_expiry_idx')
      .on(t.accessTokenExpiresAt)
      .where(sql`${t.status} in ('active', 'error')`),
    check('integration_accounts_provider_check', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check(
      'integration_accounts_status_check',
      sql`${t.status} in ('connecting', 'active', 'refresh_required', 'error', 'disconnected')`,
    ),
    // Disconnected accounts hold no tokens; connected ones always do.
    check(
      'integration_accounts_tokens_check',
      sql`(${t.status} = 'disconnected' and ${t.tokensSealed} is null) or (${t.status} = 'connecting') or (${t.status} in ('active', 'refresh_required', 'error') and ${t.tokensSealed} is not null)`,
    ),
    check(
      'integration_accounts_error_check',
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`,
    ),
    check(
      'integration_accounts_label_check',
      sql`char_length(${t.accountLabel}) between 1 and 320`,
    ),
    tenantIsolationPolicy(),
  ],
);

/**
 * A pending OAuth authorization: the `state` sent to the provider (stored as a SHA-256 hash),
 * the PKCE verifier (sealed), who started it and what to do on return. Single use, 10 minutes.
 */
export const integrationOauthStates = pgTable(
  'integration_oauth_states',
  {
    id: primaryId(),
    organizationId: orgId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    /** What the authorization is for (e.g. `calendar`). */
    purpose: text().notNull(),
    stateHash: text().notNull(),
    codeVerifierSealed: text().notNull(),
    /** Purpose details (e.g. `{ calendarId }`), validated again on return. */
    context: jsonb().notNull().default({}),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integration_oauth_states_hash_unique').on(t.stateHash),
    index('integration_oauth_states_expiry_idx').on(t.expiresAt),
    check('integration_oauth_states_purpose_check', sql`${t.purpose} ~ '^[a-z_]{1,40}$'`),
    tenantIsolationPolicy(),
  ],
);

export type IntegrationAccount = typeof integrationAccounts.$inferSelect;
export type IntegrationOauthState = typeof integrationOauthStates.$inferSelect;
