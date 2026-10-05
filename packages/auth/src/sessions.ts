import {
  sessions,
  users,
  withSystem,
  withUser,
  type AuthMethod,
  type Database,
  type Tx,
  type User,
} from '@businessos/database';
import { NotFoundError } from '@businessos/shared';
import { resolveMembership } from '@businessos/organizations';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AuthConfig } from './config';
import { generateToken, hashToken, isWellFormedToken } from './crypto';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  locale: string;
  timezone: string;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: SessionUser;
  authMethod: AuthMethod;
  activeOrganizationId: string | null;
  mfaVerified: boolean;
}

export interface SessionClientInfo {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null,
    locale: user.locale,
    timezone: user.timezone,
  };
}

const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function sanitizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  // Accept IPv4/IPv6 literals only; anything else is dropped rather than failing the insert.
  return /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : null;
}

/** Creates a new session and returns the opaque token (shown to the client exactly once). */
export async function createSession(
  tx: Tx,
  config: AuthConfig,
  userId: string,
  authMethod: AuthMethod,
  client: SessionClientInfo,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = new Date(now + config.sessionTtlSeconds * 1000);
  const [row] = await tx
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      authMethod,
      ipAddress: sanitizeIp(client.ipAddress),
      userAgent: client.userAgent?.slice(0, 512) ?? null,
      lastSeenAt: new Date(now),
      expiresAt,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, sessionId: row.id, expiresAt };
}

/**
 * Resolves a session token to an authenticated session, or null when the token is unknown,
 * revoked, expired (absolute or idle) or the user is disabled.
 */
export async function validateSession(
  db: Database,
  config: AuthConfig,
  token: string | undefined,
): Promise<AuthenticatedSession | null> {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = hashToken(token);
  // System scope: the session token is the only credential; the user is unknown until it resolves.
  return withSystem(db, async (tx) => {
    const [row] = await tx
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash));
    if (!row) return null;
    const { session, user } = row;
    const now = Date.now();
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= now) return null;
    if (session.lastSeenAt.getTime() + config.sessionIdleTimeoutSeconds * 1000 <= now) return null;
    if (user.status !== 'active') return null;

    if (now - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await tx
        .update(sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(sessions.id, session.id));
    }
    return {
      sessionId: session.id,
      user: toSessionUser(user),
      authMethod: session.authMethod,
      activeOrganizationId: session.activeOrganizationId,
      mfaVerified: session.mfaVerifiedAt !== null,
    };
  });
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  // System scope: logout must work even if the session's user can no longer be resolved.
  await withSystem(db, (tx) =>
    tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))),
  );
}

/** Revokes every active session of a user, optionally keeping one (e.g. the current one). */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
  const rows = await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  return rows.length;
}

/**
 * Records the organization the user switched to. Membership is re-verified here and on every
 * tenant request; this value is only a default for navigation.
 */
export async function setActiveOrganization(
  db: Database,
  session: AuthenticatedSession,
  organizationId: string,
): Promise<void> {
  const membership = await resolveMembership(db, session.user.id, organizationId);
  if (!membership) throw new NotFoundError('Organization');
  await withUser(db, session.user.id, (tx) =>
    tx
      .update(sessions)
      .set({ activeOrganizationId: organizationId })
      .where(and(eq(sessions.id, session.sessionId), eq(sessions.userId, session.user.id))),
  );
}
