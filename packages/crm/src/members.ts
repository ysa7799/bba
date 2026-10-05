import { memberships, users, type TenantTx } from '@businessos/database';
import { ValidationError } from '@businessos/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** Throws unless `userId` is an active member of the organization (owners, assignees…). */
export async function assertActiveMember(
  tx: TenantTx,
  organizationId: string,
  userId: string,
  path: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!row) {
    throw new ValidationError('Invalid user', [
      { path, message: 'Must be an active member of this organization' },
    ]);
  }
}

export interface Assignee {
  userId: string;
  name: string;
  email: string;
}

/** Active members that records can be assigned to (owner/assignee pickers, import mapping). */
export async function listAssignees(tx: TenantTx, organizationId: string): Promise<Assignee[]> {
  return tx
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, 'active')))
    .orderBy(asc(users.name), asc(users.id))
    .limit(1_000);
}

/** Display names for a set of users that are (or were) visible in this tenant. */
export async function userNames(
  tx: TenantTx,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}
