import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { organizations } from './organizations';
import { roles } from './rbac';
import { users } from './users';

export const AUTH_METHODS = ['password', 'invitation', 'email_verification'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * Server-side sessions (ADR-008). Only the SHA-256 hash of the opaque token is stored.
 * Looked up in system scope (the user is unknown until the token resolves); a user may also
 * read/revoke their own sessions in user scope.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull(),
    authMethod: text({ enum: AUTH_METHODS }).notNull(),
    /** Set when a second factor has been verified for this session (MFA, future). */
    mfaVerifiedAt: timestamp({ withTimezone: true }),
    /** Last organization the user switched to; a convenience default, never an authorization. */
    activeOrganizationId: uuid().references(() => organizations.id, { onDelete: 'set null' }),
    ipAddress: inet(),
    userAgent: text(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
    check(
      'sessions_auth_method_check',
      sql`${t.authMethod} in ('password', 'invitation', 'email_verification')`,
    ),
    check('sessions_token_hash_format_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    pgPolicy('sessions_access', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system() OR ${t.userId} = app_current_user()`,
      withCheck: sql`app_is_system() OR ${t.userId} = app_current_user()`,
    }),
  ],
);

export const AUTH_TOKEN_PURPOSES = ['email_verification', 'password_reset'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/** Single-use, expiring tokens for email verification and password reset (hash only). */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: primaryId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text({ enum: AUTH_TOKEN_PURPOSES }).notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().$type<Record<string, string>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_unique').on(t.tokenHash),
    index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
    check(
      'auth_tokens_purpose_check',
      sql`${t.purpose} in ('email_verification', 'password_reset')`,
    ),
    check('auth_tokens_token_hash_format_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    // Only the authentication service (system scope) touches tokens.
    pgPolicy('auth_tokens_system_only', {
      as: 'permissive',
      for: 'all',
      using: sql`app_is_system()`,
      withCheck: sql`app_is_system()`,
    }),
  ],
);

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Invitations to join an organization. Expiry is evaluated against `expires_at`. */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Normalized email the invitation is bound to. */
    email: text().notNull(),
    tokenHash: text().notNull(),
    /** Role granted on acceptance (same-tenant composite FK). */
    roleId: uuid().notNull(),
    status: text({ enum: INVITATION_STATUSES }).notNull().default('pending'),
    invitedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_unique').on(t.tokenHash),
    uniqueIndex('invitations_pending_email_unique')
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
    index('invitations_org_created_idx').on(t.organizationId, t.createdAt),
    check('invitations_status_check', sql`${t.status} in ('pending', 'accepted', 'revoked')`),
    check('invitations_email_normalized_check', sql`${t.email} = lower(btrim(${t.email}))`),
    check('invitations_token_hash_format_check', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: 'invitations_role_fk',
      columns: [t.roleId, t.organizationId],
      foreignColumns: [roles.id, roles.organizationId],
    }).onDelete('restrict'),
    tenantIsolationPolicy(),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
