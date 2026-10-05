import {
  invitations,
  memberships,
  organizations,
  users,
  withSystem,
  type Database,
  type Invitation,
  type SystemTx,
  type TenantTx,
} from '@businessos/database';
import {
  assertCanInviteWithRole,
  assignRoleOnJoin,
  type MemberActor,
} from '@businessos/organizations';
import {
  ConflictError,
  ForbiddenError,
  InvalidTokenError,
  NotFoundError,
} from '@businessos/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { AuthServices } from './accounts';
import { emailSchema, personNameSchema } from './accounts';
import type { AuthConfig } from './config';
import { generateToken, hashToken, isWellFormedToken } from './crypto';
import type { AuthEmail } from './mailer';
import { hashPassword, passwordSchema } from './password';
import { recordAudit } from '@businessos/audit';
import { assertSeatsAvailable } from '@businessos/billing';
import { emitEvent } from '@businessos/events';
import {
  toSessionUser,
  userAuditContext,
  type SessionClientInfo,
  type SessionUser,
} from './sessions';

export interface CreatedInvitation {
  invitation: Invitation;
  /** Plain token; only ever placed in the invitation email link. */
  token: string;
  email: AuthEmail;
}

/**
 * Creates (or re-issues) an invitation inside the inviting organization's tenant scope.
 * The caller checks `settings.users.manage`; this function enforces that the inviter may grant
 * the invited role. The caller sends `email` after commit.
 */
export async function createInvitation(
  tx: TenantTx,
  config: AuthConfig,
  input: { organizationId: string; email: string; roleId: string; invitedBy: MemberActor },
): Promise<CreatedInvitation> {
  const email = emailSchema.parse(input.email);
  await assertCanInviteWithRole(tx, input.organizationId, input.invitedBy, input.roleId);

  const [organization] = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId));
  if (!organization) throw new NotFoundError('Organization');

  // Member users are visible in tenant scope (users_select policy).
  const [existingMember] = await tx
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organization.id), eq(users.email, email)));
  if (existingMember?.status === 'active') {
    throw new ConflictError('This person is already a member of the organization');
  }

  // Re-inviting replaces the previous pending invitation (and invalidates its link).
  await tx
    .update(invitations)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(invitations.organizationId, organization.id),
        eq(invitations.email, email),
        eq(invitations.status, 'pending'),
      ),
    );

  // The new pending invitation occupies a seat until accepted or revoked.
  await assertSeatsAvailable(tx, organization.id, 1);

  const token = generateToken();
  const [invitation] = await tx
    .insert(invitations)
    .values({
      organizationId: organization.id,
      email,
      tokenHash: hashToken(token),
      roleId: input.roleId,
      invitedByUserId: input.invitedBy.userId,
      expiresAt: new Date(Date.now() + config.invitationTtlSeconds * 1000),
    })
    .returning();
  if (!invitation) throw new Error('invitation insert returned no row');
  await emitEvent(tx, {
    type: 'member.invited',
    organizationId: organization.id,
    subject: { type: 'invitation', id: invitation.id },
    actor: { type: 'user', id: input.invitedBy.userId },
    payload: { invitationId: invitation.id, roleId: input.roleId },
    correlationId: input.invitedBy.correlationId,
  });

  const [inviter] = await tx
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.invitedBy.userId));
  const inviterName = inviter?.name ?? null;

  const url = new URL('/invite', `${config.appUrl}/`);
  url.searchParams.set('token', token);
  return {
    invitation,
    token,
    email: {
      kind: 'invitation',
      to: email,
      locale: 'en',
      organizationName: organization.name,
      inviterName,
      link: url.toString(),
    },
  };
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  inviterName: string | null;
  expiresAt: Date;
  /** Whether an account already exists for the invited email (so the UI offers sign-in). */
  accountExists: boolean;
}

async function lockPendingInvitation(tx: SystemTx, token: string) {
  if (!isWellFormedToken(token)) throw new InvalidTokenError();
  const [row] = await tx
    .select({ invitation: invitations, organization: organizations })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        eq(invitations.status, 'pending'),
        gt(invitations.expiresAt, sql`now()`),
        eq(organizations.status, 'active'),
        isNull(organizations.deletedAt),
      ),
    )
    .for('update', { of: invitations });
  if (!row) throw new InvalidTokenError('This invitation is invalid or has expired');
  return row;
}

/**
 * Shows who invited whom to what. Only the holder of the token (the invited mailbox) can call
 * this, so revealing whether an account exists for that same email is acceptable.
 */
export async function previewInvitation(db: Database, token: string): Promise<InvitationPreview> {
  // System scope: the invitation token is the credential; no user or tenant is established.
  return withSystem(db, async (tx) => {
    const { invitation, organization } = await lockPendingInvitation(tx, token);
    let inviterName: string | null = null;
    if (invitation.invitedByUserId) {
      const [inviter] = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, invitation.invitedByUserId));
      inviterName = inviter?.name ?? null;
    }
    const [account] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email));
    return {
      organizationName: organization.name,
      email: invitation.email,
      inviterName,
      expiresAt: invitation.expiresAt,
      accountExists: account !== undefined,
    };
  });
}

async function joinOrganization(
  tx: SystemTx,
  invitation: Invitation,
  user: { id: string; email: string },
  client: SessionClientInfo | undefined,
): Promise<void> {
  const userId = user.id;
  const [existing] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, invitation.organizationId),
        eq(memberships.userId, userId),
      ),
    )
    .for('update');
  // The pending invitation already holds a seat; joining converts it. Re-check in case the
  // plan's member limit was lowered after the invitation was sent.
  if (existing?.status !== 'active') {
    await assertSeatsAvailable(tx, invitation.organizationId, 0);
  }
  let membershipId: string;
  if (!existing) {
    const [created] = await tx
      .insert(memberships)
      .values({ organizationId: invitation.organizationId, userId, status: 'active' })
      .returning({ id: memberships.id });
    if (!created) throw new Error('membership insert returned no row');
    membershipId = created.id;
  } else {
    membershipId = existing.id;
    if (existing.status !== 'active') {
      // An administrator re-invited a suspended member: the invitation reactivates them.
      await tx.update(memberships).set({ status: 'active' }).where(eq(memberships.id, existing.id));
    }
  }
  await assignRoleOnJoin(tx, invitation.organizationId, membershipId, invitation.roleId);
  await emitEvent(tx, {
    type: 'member.joined',
    organizationId: invitation.organizationId,
    subject: { type: 'membership', id: membershipId },
    actor: { type: 'user', id: userId },
    payload: { membershipId, userId, via: 'invitation' },
    correlationId: client?.requestId ?? null,
  });
  await recordAudit(tx, userAuditContext(user, client), {
    organizationId: invitation.organizationId,
    action: 'member.joined',
    target: { type: 'membership', id: membershipId },
    metadata: { invitationId: invitation.id, roleId: invitation.roleId },
  });
  await tx
    .update(invitations)
    .set({ status: 'accepted', acceptedByUserId: userId, acceptedAt: new Date() })
    .where(eq(invitations.id, invitation.id));
}

/**
 * Accepts an invitation as the signed-in user. The user's email must match the invitation.
 * Possession of the token proves control of that mailbox, so the email is marked verified.
 */
export async function acceptInvitation(
  db: Database,
  user: SessionUser,
  token: string,
  client?: SessionClientInfo,
): Promise<{ organizationId: string }> {
  // System scope: the accepting user is not yet a member, so no tenant scope can authorize it.
  return withSystem(db, async (tx) => {
    const { invitation } = await lockPendingInvitation(tx, token);
    if (invitation.email !== user.email) {
      throw new ForbiddenError(
        'This invitation was sent to a different email address. Sign in with that account.',
      );
    }
    await tx
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, user.id));
    await joinOrganization(tx, invitation, user, client);
    return { organizationId: invitation.organizationId };
  });
}

/**
 * Creates an account for an invited person and joins the organization in one step. The email
 * comes from the invitation (never from the client) and is verified by the token.
 */
export async function acceptInvitationAsNewUser(
  services: AuthServices,
  token: string,
  rawInput: { name: string; password: string },
  client?: SessionClientInfo,
): Promise<{ user: SessionUser; organizationId: string }> {
  const name = personNameSchema.parse(rawInput.name);
  const password = passwordSchema.parse(rawInput.password);
  const passwordHash = await hashPassword(password, services.config.password);
  // System scope: account creation and first membership for a not-yet-existing user.
  return withSystem(services.db, async (tx) => {
    const { invitation } = await lockPendingInvitation(tx, token);
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email));
    if (existing) {
      throw new ConflictError('An account already exists for this email. Sign in to accept.');
    }
    const [created] = await tx
      .insert(users)
      .values({ email: invitation.email, name, passwordHash, emailVerifiedAt: new Date() })
      .returning();
    if (!created) throw new Error('user insert returned no row');
    await joinOrganization(tx, invitation, created, client);
    return { user: toSessionUser(created), organizationId: invitation.organizationId };
  });
}
