import {
  authTokens,
  membershipRoles,
  memberships,
  sessions,
  users,
  withSystem,
  withTenant,
  type DatabaseHandle,
} from '@businessos/database';
import {
  ConflictError,
  EmailNotVerifiedError,
  ForbiddenError,
  InvalidTokenError,
  UnauthenticatedError,
  ValidationError,
} from '@businessos/shared';
import {
  actorFor,
  createTestDatabase,
  createTestWorld,
  systemRoleId,
  uniqueSuffix,
  type TestWorld,
} from '@businessos/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  acceptInvitationAsNewUser,
  changePassword,
  createInvitation,
  defaultAuthConfig,
  hashPassword,
  login,
  MemoryMailer,
  needsRehash,
  previewInvitation,
  register,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  tokenFromLink,
  validateSession,
  verifyEmail,
  type AuthConfig,
  type AuthServices,
} from '../src';

let handle: DatabaseHandle;
let world: TestWorld;
let services: AuthServices;
let mailer: MemoryMailer;
let config: AuthConfig;

const PASSWORD = 'correct horse battery staple';

beforeAll(async () => {
  handle = createTestDatabase();
  world = await createTestWorld(handle.db);
  mailer = new MemoryMailer();
  config = {
    ...defaultAuthConfig('http://localhost:3000'),
    password: { memoryCostKib: 1024, timeCost: 1, parallelism: 1 },
  };
  services = { db: handle.db, config, mailer };
});

afterAll(async () => {
  await handle.close();
});

function email(label: string): string {
  return `${label}.${uniqueSuffix()}@example.com`;
}

async function registerAndVerify(address: string, password = PASSWORD) {
  await register(services, { name: 'Test Person', email: address, password });
  const sent = mailer.lastTo(address);
  if (sent?.kind !== 'verify_email') throw new Error('no verification email');
  return verifyEmail(services, tokenFromLink(sent.link));
}

describe('registration', () => {
  it('creates an unverified account and sends a verification link', async () => {
    const address = email('new');
    await register(services, { name: 'Fatima', email: address.toUpperCase(), password: PASSWORD });
    const sent = mailer.lastTo(address);
    expect(sent?.kind).toBe('verify_email');
    const [user] = await withSystem(handle.db, (tx) =>
      tx.select().from(users).where(eq(users.email, address)),
    );
    expect(user?.emailVerifiedAt).toBeNull();
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain(PASSWORD);
  });

  it('does not reveal existing verified accounts and does not change them', async () => {
    const address = email('existing');
    await registerAndVerify(address);
    mailer.clear();
    await expect(
      register(services, { name: 'Attacker', email: address, password: 'another password 123' }),
    ).resolves.toBeUndefined();
    expect(mailer.lastTo(address)?.kind).toBe('account_exists');
    await expect(
      login(services, { email: address, password: 'another password 123' }, {}),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(login(services, { email: address, password: PASSWORD }, {})).resolves.toBeTruthy();
  });

  it('lets the latest registrant own an unverified email (pre-hijack protection)', async () => {
    const address = email('prehijack');
    await register(services, { name: 'Attacker', email: address, password: 'attacker password 1' });
    const attackerLink = mailer.lastTo(address);
    await register(services, { name: 'Owner', email: address, password: PASSWORD });
    const ownerLink = mailer.lastTo(address);
    if (attackerLink?.kind !== 'verify_email' || ownerLink?.kind !== 'verify_email') {
      throw new Error('expected verification emails');
    }
    // The first link is invalidated when a new one is issued.
    await expect(verifyEmail(services, tokenFromLink(attackerLink.link))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await verifyEmail(services, tokenFromLink(ownerLink.link));
    await expect(
      login(services, { email: address, password: 'attacker password 1' }, {}),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(login(services, { email: address, password: PASSWORD }, {})).resolves.toBeTruthy();
  });

  it('enforces the password policy', async () => {
    for (const weak of ['short', '1234567890', 'aaaaaaaaaaaa']) {
      await expect(
        register(services, { name: 'Weak', email: email('weak'), password: weak }),
      ).rejects.toThrow();
    }
  });

  it('rejects malformed emails', async () => {
    await expect(
      register(services, { name: 'X', email: 'not-an-email', password: PASSWORD }),
    ).rejects.toThrow();
  });
});

describe('email verification', () => {
  it('verifies once; tokens are single use', async () => {
    const address = email('verify');
    await register(services, { name: 'V', email: address, password: PASSWORD });
    const sent = mailer.lastTo(address);
    if (sent?.kind !== 'verify_email') throw new Error('no email');
    const token = tokenFromLink(sent.link);
    const user = await verifyEmail(services, token);
    expect(user.emailVerified).toBe(true);
    await expect(verifyEmail(services, token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects malformed, unknown and expired tokens', async () => {
    await expect(verifyEmail(services, 'garbage')).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifyEmail(services, 'A'.repeat(43))).rejects.toBeInstanceOf(InvalidTokenError);

    const address = email('expired');
    await register(services, { name: 'E', email: address, password: PASSWORD });
    const sent = mailer.lastTo(address);
    if (sent?.kind !== 'verify_email') throw new Error('no email');
    await withSystem(handle.db, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.email, address));
      await tx
        .update(authTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(authTokens.userId, user!.id));
    });
    await expect(verifyEmail(services, tokenFromLink(sent.link))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('resends only for unverified accounts, silently otherwise', async () => {
    const address = email('resend');
    await register(services, { name: 'R', email: address, password: PASSWORD });
    mailer.clear();
    await resendVerification(services, address);
    expect(mailer.lastTo(address)?.kind).toBe('verify_email');
    mailer.clear();
    await resendVerification(services, email('nobody'));
    expect(mailer.sent).toEqual([]);
  });
});

describe('login and sessions', () => {
  it('does not distinguish unknown emails from wrong passwords', async () => {
    const address = email('login');
    await registerAndVerify(address);
    const unknown = login(services, { email: email('ghost'), password: PASSWORD }, {});
    const wrong = login(services, { email: address, password: 'wrong password!!' }, {});
    await expect(unknown).rejects.toMatchObject({ message: 'Invalid email or password' });
    await expect(wrong).rejects.toMatchObject({ message: 'Invalid email or password' });
  });

  it('requires a verified email', async () => {
    const address = email('unverified');
    await register(services, { name: 'U', email: address, password: PASSWORD });
    await expect(
      login(services, { email: address, password: PASSWORD }, {}),
    ).rejects.toBeInstanceOf(EmailNotVerifiedError);
  });

  it('issues opaque tokens stored only as hashes and validates them', async () => {
    const address = email('session');
    await registerAndVerify(address);
    const result = await login(
      services,
      { email: address, password: PASSWORD },
      { ipAddress: '10.0.0.1', userAgent: 'vitest' },
    );
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await withSystem(handle.db, (tx) =>
      tx.select().from(sessions).where(eq(sessions.id, result.sessionId)),
    );
    expect(rows[0]?.tokenHash).not.toBe(result.token);
    const session = await validateSession(handle.db, config, result.token);
    expect(session?.user.email).toBe(address);
    expect(await validateSession(handle.db, config, `${result.token.slice(0, 42)}x`)).toBeNull();
    expect(await validateSession(handle.db, config, undefined)).toBeNull();
  });

  it('expires sessions by absolute and idle timeouts and for disabled users', async () => {
    const address = email('expiry');
    const user = await registerAndVerify(address);
    const absolute = await login(services, { email: address, password: PASSWORD }, {});
    await withSystem(handle.db, (tx) =>
      tx
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(sessions.id, absolute.sessionId)),
    );
    expect(await validateSession(handle.db, config, absolute.token)).toBeNull();

    const idle = await login(services, { email: address, password: PASSWORD }, {});
    await withSystem(handle.db, (tx) =>
      tx
        .update(sessions)
        .set({ lastSeenAt: new Date(Date.now() - (config.sessionIdleTimeoutSeconds + 5) * 1000) })
        .where(eq(sessions.id, idle.sessionId)),
    );
    expect(await validateSession(handle.db, config, idle.token)).toBeNull();

    const active = await login(services, { email: address, password: PASSWORD }, {});
    await withSystem(handle.db, (tx) =>
      tx.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id)),
    );
    expect(await validateSession(handle.db, config, active.token)).toBeNull();
    await expect(login(services, { email: address, password: PASSWORD }, {})).rejects.toMatchObject(
      { message: 'This account is disabled' },
    );
  });

  it('rehashes passwords created with outdated parameters on login', async () => {
    const address = email('rehash');
    await registerAndVerify(address);
    const weakHash = await hashPassword(PASSWORD, {
      memoryCostKib: 512,
      timeCost: 1,
      parallelism: 1,
    });
    await withSystem(handle.db, (tx) =>
      tx.update(users).set({ passwordHash: weakHash }).where(eq(users.email, address)),
    );
    await login(services, { email: address, password: PASSWORD }, {});
    const [row] = await withSystem(handle.db, (tx) =>
      tx.select().from(users).where(eq(users.email, address)),
    );
    expect(needsRehash(row?.passwordHash ?? '', config.password)).toBe(false);
  });
});

describe('password reset', () => {
  it('resets the password, verifies the email and revokes all sessions', async () => {
    const address = email('reset');
    await registerAndVerify(address);
    const before = await login(services, { email: address, password: PASSWORD }, {});
    mailer.clear();
    await requestPasswordReset(services, address);
    const sent = mailer.lastTo(address);
    if (sent?.kind !== 'password_reset') throw new Error('no reset email');
    const token = tokenFromLink(sent.link);
    await resetPassword(services, token, 'brand new password 42');
    expect(await validateSession(handle.db, config, before.token)).toBeNull();
    await expect(
      login(services, { email: address, password: PASSWORD }, {}),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      login(services, { email: address, password: 'brand new password 42' }, {}),
    ).resolves.toBeTruthy();
    await expect(resetPassword(services, token, 'another password 99')).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    expect(mailer.lastTo(address)?.kind).toBe('password_changed');
  });

  it('is silent for unknown emails', async () => {
    mailer.clear();
    await requestPasswordReset(services, email('unknown'));
    expect(mailer.sent).toEqual([]);
  });

  it('only the newest reset link works', async () => {
    const address = email('reset2');
    await registerAndVerify(address);
    await requestPasswordReset(services, address);
    const first = mailer.lastTo(address);
    await requestPasswordReset(services, address);
    const second = mailer.lastTo(address);
    if (first?.kind !== 'password_reset' || second?.kind !== 'password_reset') {
      throw new Error('no reset emails');
    }
    await expect(
      resetPassword(services, tokenFromLink(first.link), 'brand new password 42'),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await resetPassword(services, tokenFromLink(second.link), 'brand new password 42');
  });

  it('rejects weak new passwords without consuming the token', async () => {
    const address = email('reset3');
    await registerAndVerify(address);
    await requestPasswordReset(services, address);
    const sent = mailer.lastTo(address);
    if (sent?.kind !== 'password_reset') throw new Error('no reset email');
    await expect(resetPassword(services, tokenFromLink(sent.link), 'short')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await resetPassword(services, tokenFromLink(sent.link), 'good long password 7');
  });

  it('changes password when signed in and revokes other sessions only', async () => {
    const address = email('change');
    const user = await registerAndVerify(address);
    const current = await login(services, { email: address, password: PASSWORD }, {});
    const other = await login(services, { email: address, password: PASSWORD }, {});
    await expect(
      changePassword(services, user.id, current.sessionId, {
        currentPassword: 'wrong',
        newPassword: 'changed password 11',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await changePassword(services, user.id, current.sessionId, {
      currentPassword: PASSWORD,
      newPassword: 'changed password 11',
    });
    expect(await validateSession(handle.db, config, current.token)).not.toBeNull();
    expect(await validateSession(handle.db, config, other.token)).toBeNull();
  });
});

describe('invitations', () => {
  async function invite(address: string, organizationId = world.orgA.organization.id) {
    const invitedBy = await actorFor(handle.db, organizationId, world.orgA.users.owner.id);
    const roleId = await systemRoleId(handle.db, organizationId, 'member');
    return withTenant(handle.db, { organizationId, userId: world.orgA.users.owner.id }, (tx) =>
      createInvitation(tx, config, { organizationId, email: address, roleId, invitedBy }),
    );
  }

  it('lets a new person accept, creating a verified account and membership', async () => {
    const address = email('invitee');
    const { token } = await invite(address);
    const preview = await previewInvitation(handle.db, token);
    expect(preview).toMatchObject({
      organizationName: world.orgA.organization.name,
      email: address,
      accountExists: false,
    });
    const result = await acceptInvitationAsNewUser(services, token, {
      name: 'Invitee',
      password: PASSWORD,
    });
    expect(result.user.emailVerified).toBe(true);
    expect(result.organizationId).toBe(world.orgA.organization.id);
    await expect(previewInvitation(handle.db, token)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(login(services, { email: address, password: PASSWORD }, {})).resolves.toBeTruthy();
  });

  it('binds acceptance to the invited email', async () => {
    const address = email('bound');
    const { token } = await invite(address);
    const someoneElse = await registerAndVerify(email('other'));
    await expect(acceptInvitation(handle.db, someoneElse, token)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const invited = await registerAndVerify(address);
    await expect(acceptInvitation(handle.db, invited, token)).resolves.toEqual({
      organizationId: world.orgA.organization.id,
    });
    const rows = await withSystem(handle.db, (tx) =>
      tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, invited.id),
            eq(memberships.organizationId, world.orgA.organization.id),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to create a second account for an existing email', async () => {
    const address = email('dupe');
    await registerAndVerify(address);
    const { token } = await invite(address);
    await expect(
      acceptInvitationAsNewUser(services, token, { name: 'X', password: PASSWORD }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('invalidates the previous link when re-invited and rejects expired invitations', async () => {
    const address = email('reinvite');
    const first = await invite(address);
    const second = await invite(address);
    await expect(previewInvitation(handle.db, first.token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    await expect(previewInvitation(handle.db, second.token)).resolves.toBeTruthy();
  });

  it('rejects inviting existing members', async () => {
    await expect(invite(world.orgA.users.sales.email)).rejects.toBeInstanceOf(ConflictError);
  });

  it('cannot create invitations for another organization from tenant A scope', async () => {
    const invitedBy = await actorFor(
      handle.db,
      world.orgA.organization.id,
      world.orgA.users.owner.id,
    );
    const foreignRole = await systemRoleId(handle.db, world.orgB.organization.id, 'member');
    await expect(
      withTenant(
        handle.db,
        { organizationId: world.orgA.organization.id, userId: world.orgA.users.owner.id },
        (tx) =>
          createInvitation(tx, config, {
            organizationId: world.orgB.organization.id,
            email: email('cross'),
            roleId: foreignRole,
            invitedBy,
          }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('assigns the invited role on acceptance', async () => {
    const address = email('roled');
    const { token } = await invite(address);
    const result = await acceptInvitationAsNewUser(services, token, {
      name: 'Roled',
      password: PASSWORD,
    });
    const actor = await actorFor(handle.db, world.orgA.organization.id, result.user.id);
    expect(actor.isOwner).toBe(false);
    const memberRoleId = await systemRoleId(handle.db, world.orgA.organization.id, 'member');
    const assigned = await withSystem(handle.db, (tx) =>
      tx
        .select({ roleId: membershipRoles.roleId })
        .from(membershipRoles)
        .where(eq(membershipRoles.membershipId, actor.membershipId)),
    );
    expect(assigned.map((row) => row.roleId)).toEqual([memberRoleId]);
  });
});
