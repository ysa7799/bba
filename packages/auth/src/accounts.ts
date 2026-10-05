import {
  authTokens,
  isUniqueViolation,
  users,
  withSystem,
  type AuthTokenPurpose,
  type Database,
  type SystemTx,
  type User,
} from '@businessos/database';
import {
  EmailNotVerifiedError,
  InvalidTokenError,
  UnauthenticatedError,
  ValidationError,
} from '@businessos/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthConfig } from './config';
import { generateToken, hashToken, isWellFormedToken, normalizeEmail } from './crypto';
import type { AuthEmail, AuthMailer } from './mailer';
import {
  burnPasswordCheck,
  hashPassword,
  needsRehash,
  passwordSchema,
  verifyPassword,
} from './password';
import {
  createSession,
  revokeUserSessions,
  toSessionUser,
  type SessionClientInfo,
  type SessionUser,
} from './sessions';

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }))
  .transform(normalizeEmail);

export const personNameSchema = z.string().trim().min(1).max(200);

export const registerInputSchema = z.object({
  name: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
  locale: z.enum(['en', 'ar']).default('en'),
});

export type RegisterInput = z.input<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: emailSchema,
  // Do not apply the password policy at login (old passwords must still work); only bound size.
  password: z.string().min(1).max(1024),
});

export interface AuthServices {
  db: Database;
  config: AuthConfig;
  mailer: AuthMailer;
}

async function issueToken(
  tx: SystemTx,
  config: AuthConfig,
  user: Pick<User, 'id' | 'email'>,
  purpose: AuthTokenPurpose,
): Promise<string> {
  // Only the newest token of a purpose is valid.
  await tx
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, user.id),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
      ),
    );
  const ttl =
    purpose === 'email_verification'
      ? config.emailVerificationTtlSeconds
      : config.passwordResetTtlSeconds;
  const token = generateToken();
  await tx.insert(authTokens).values({
    userId: user.id,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttl * 1000),
    // Bind the token to the email it was sent to; an email change invalidates it.
    metadata: { email: user.email },
  });
  return token;
}

/**
 * Atomically consumes a token (single use even under concurrent requests).
 * Returns the user id, or throws InvalidTokenError.
 */
async function consumeToken(tx: SystemTx, token: string, purpose: AuthTokenPurpose): Promise<User> {
  if (!isWellFormedToken(token)) throw new InvalidTokenError();
  const [consumed] = await tx
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, purpose),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: authTokens.userId, metadata: authTokens.metadata });
  if (!consumed) throw new InvalidTokenError();
  const [user] = await tx.select().from(users).where(eq(users.id, consumed.userId)).for('update');
  if (user?.status !== 'active' || consumed.metadata?.email !== user.email) {
    throw new InvalidTokenError();
  }
  return user;
}

function link(config: AuthConfig, path: string, token: string): string {
  const url = new URL(path, `${config.appUrl}/`);
  url.searchParams.set('token', token);
  return url.toString();
}

async function deliver(mailer: AuthMailer, emails: AuthEmail[]): Promise<void> {
  // Emails are sent only after the transaction committed. Delivery failures surface to the
  // caller's logger; the user can always request a new link.
  for (const email of emails) {
    await mailer.send(email);
  }
}

/**
 * Registers an account. The response never reveals whether the email already exists:
 *  - new email → create unverified user + verification email
 *  - existing unverified → the latest registrant's password replaces the old one (unverified
 *    accounts are not owned yet, preventing pre-registration hijacking) + new verification
 *  - existing verified → "account exists" email pointing to password recovery; nothing changes
 */
export async function register(services: AuthServices, rawInput: RegisterInput): Promise<void> {
  const input = registerInputSchema.parse(rawInput);
  // Hash before the transaction in every branch: keeps timing uniform and transactions short.
  const passwordHash = await hashPassword(input.password, services.config.password);

  const emails: AuthEmail[] = [];
  try {
    // System scope: registration precedes any identity; users is a global table.
    await withSystem(services.db, async (tx) => {
      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.email, input.email))
        .for('update');

      if (existing?.emailVerifiedAt) {
        if (existing.status === 'active') {
          // No token here: repeated registrations must not invalidate the owner's reset links.
          emails.push({
            kind: 'account_exists',
            to: existing.email,
            locale: existing.locale,
            name: existing.name,
            forgotPasswordLink: new URL(
              '/forgot-password',
              `${services.config.appUrl}/`,
            ).toString(),
          });
        }
        return;
      }

      let user: User;
      if (existing) {
        const [updated] = await tx
          .update(users)
          .set({ passwordHash, name: input.name, locale: input.locale })
          .where(eq(users.id, existing.id))
          .returning();
        if (!updated) throw new Error('user update returned no row');
        user = updated;
      } else {
        const [created] = await tx
          .insert(users)
          .values({
            email: input.email,
            name: input.name,
            locale: input.locale,
            passwordHash,
          })
          .returning();
        if (!created) throw new Error('user insert returned no row');
        user = created;
      }
      if (user.status !== 'active') return;
      const token = await issueToken(tx, services.config, user, 'email_verification');
      emails.push({
        kind: 'verify_email',
        to: user.email,
        locale: user.locale,
        name: user.name,
        link: link(services.config, '/verify-email', token),
      });
    });
  } catch (error) {
    // A concurrent registration for the same email won the race: respond identically.
    if (isUniqueViolation(error, 'users_email_unique')) return;
    throw error;
  }
  await deliver(services.mailer, emails);
}

/** Re-sends a verification link if the account exists and is unverified. Never reveals which. */
export async function resendVerification(services: AuthServices, rawEmail: string): Promise<void> {
  const email = emailSchema.parse(rawEmail);
  const emails: AuthEmail[] = [];
  // System scope: unauthenticated flow on the global users table.
  await withSystem(services.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.email, email)).for('update');
    if (!user || user.emailVerifiedAt || user.status !== 'active') return;
    const token = await issueToken(tx, services.config, user, 'email_verification');
    emails.push({
      kind: 'verify_email',
      to: user.email,
      locale: user.locale,
      name: user.name,
      link: link(services.config, '/verify-email', token),
    });
  });
  await deliver(services.mailer, emails);
}

/** Marks the email as verified. Does not sign the user in (they must still know the password). */
export async function verifyEmail(services: AuthServices, token: string): Promise<SessionUser> {
  // System scope: the token is the only credential presented.
  return withSystem(services.db, async (tx) => {
    const user = await consumeToken(tx, token, 'email_verification');
    const [updated] = await tx
      .update(users)
      .set({ emailVerifiedAt: user.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, user.id))
      .returning();
    if (!updated) throw new InvalidTokenError();
    return toSessionUser(updated);
  });
}

export interface LoginResult {
  token: string;
  sessionId: string;
  expiresAt: Date;
  user: SessionUser;
}

/**
 * Password login. Unknown email and wrong password are indistinguishable (same error, same
 * timing). Account-state errors are revealed only after the correct password was supplied.
 * Always creates a fresh session (prevents session fixation).
 */
export async function login(
  services: AuthServices,
  rawInput: z.input<typeof loginInputSchema>,
  client: SessionClientInfo,
): Promise<LoginResult> {
  const input = loginInputSchema.parse(rawInput);
  // System scope: credentials are being checked; the user is not yet authenticated.
  const user = await withSystem(services.db, async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.email, input.email));
    return row ?? null;
  });

  if (!user?.passwordHash) {
    await burnPasswordCheck(input.password, services.config.password);
    throw new UnauthenticatedError('Invalid email or password');
  }
  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) throw new UnauthenticatedError('Invalid email or password');
  if (user.status !== 'active') throw new UnauthenticatedError('This account is disabled');
  if (!user.emailVerifiedAt) throw new EmailNotVerifiedError();

  const rehash = needsRehash(user.passwordHash, services.config.password)
    ? await hashPassword(input.password, services.config.password)
    : null;

  // System scope: session creation for the just-authenticated user.
  return withSystem(services.db, async (tx) => {
    const session = await createSession(tx, services.config, user.id, 'password', client);
    const [updated] = await tx
      .update(users)
      .set({ lastLoginAt: new Date(), ...(rehash ? { passwordHash: rehash } : {}) })
      .where(eq(users.id, user.id))
      .returning();
    return { ...session, user: toSessionUser(updated ?? user) };
  });
}

/** Sends a reset link when the account exists. Never reveals whether it does. */
export async function requestPasswordReset(
  services: AuthServices,
  rawEmail: string,
): Promise<void> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) {
    throw new ValidationError('Invalid input', [
      { path: 'email', message: 'Enter a valid email address' },
    ]);
  }
  const emails: AuthEmail[] = [];
  // System scope: unauthenticated flow on the global users table.
  await withSystem(services.db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.email, parsed.data)).for('update');
    if (user?.status !== 'active') return;
    const token = await issueToken(tx, services.config, user, 'password_reset');
    emails.push({
      kind: 'password_reset',
      to: user.email,
      locale: user.locale,
      name: user.name,
      link: link(services.config, '/reset-password', token),
    });
  });
  await deliver(services.mailer, emails);
}

/**
 * Completes a password reset: sets the new password, verifies the email (the reset link proved
 * mailbox ownership) and revokes every existing session.
 */
export async function resetPassword(
  services: AuthServices,
  token: string,
  newPassword: string,
): Promise<SessionUser> {
  const password = passwordSchema.safeParse(newPassword);
  if (!password.success) {
    throw new ValidationError(
      'Invalid input',
      password.error.issues.map((issue) => ({ path: 'password', message: issue.message })),
    );
  }
  const passwordHash = await hashPassword(password.data, services.config.password);
  const emails: AuthEmail[] = [];
  // System scope: the reset token is the only credential presented.
  const user = await withSystem(services.db, async (tx) => {
    const target = await consumeToken(tx, token, 'password_reset');
    const [updated] = await tx
      .update(users)
      .set({ passwordHash, emailVerifiedAt: target.emailVerifiedAt ?? new Date() })
      .where(eq(users.id, target.id))
      .returning();
    if (!updated) throw new InvalidTokenError();
    // Outstanding reset/verification links are no longer needed.
    await tx
      .update(authTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(authTokens.userId, updated.id), isNull(authTokens.consumedAt)));
    await revokeUserSessions(tx, updated.id);
    emails.push({
      kind: 'password_changed',
      to: updated.email,
      locale: updated.locale,
      name: updated.name,
    });
    return toSessionUser(updated);
  });
  await deliver(services.mailer, emails);
  return user;
}

/** Changes the password of a signed-in user and revokes their other sessions. */
export async function changePassword(
  services: AuthServices,
  sessionUserId: string,
  currentSessionId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const password = passwordSchema.safeParse(input.newPassword);
  if (!password.success) {
    throw new ValidationError(
      'Invalid input',
      password.error.issues.map((issue) => ({ path: 'newPassword', message: issue.message })),
    );
  }
  // System scope: credential management on the global users table for the session's user.
  const user = await withSystem(services.db, async (tx) => {
    const [row] = await tx.select().from(users).where(eq(users.id, sessionUserId));
    return row ?? null;
  });
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new ValidationError('Invalid input', [
      { path: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  const passwordHash = await hashPassword(password.data, services.config.password);
  await withSystem(services.db, async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await revokeUserSessions(tx, user.id, currentSessionId);
  });
  await deliver(services.mailer, [
    { kind: 'password_changed', to: user.email, locale: user.locale, name: user.name },
  ]);
}

export { createSession };
