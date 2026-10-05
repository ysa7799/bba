import {
  memberships,
  organizations,
  users,
  withSystem,
  withUser,
  type Database,
  type Membership,
  type Organization,
  type SystemTx,
  type TenantTx,
} from '@businessos/database';
import { ConflictError, decodeCursor, NotFoundError, toPage, type Page } from '@businessos/shared';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOrganizationInputSchema,
  slugBaseFromName,
  updateOrganizationInputSchema,
  type CreateOrganizationInput,
  type UpdateOrganizationInput,
} from './validation';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  timezone: string;
  locale: string;
  status: Organization['status'];
  createdAt: Date;
}

export function toOrganizationSummary(row: Organization): OrganizationSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    countryCode: row.countryCode,
    defaultCurrency: row.defaultCurrency,
    timezone: row.timezone,
    locale: row.locale,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex').slice(0, 6);
}

/**
 * Inserts the organization with a unique slug. Uses ON CONFLICT DO NOTHING so a collision does
 * not abort the surrounding transaction; retries with a random suffix.
 */
async function insertOrganizationWithUniqueSlug(
  tx: SystemTx,
  values: Omit<typeof organizations.$inferInsert, 'slug'>,
  preferredSlug: string,
  explicitSlug: boolean,
): Promise<Organization> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const slug = attempt === 0 ? preferredSlug : `${preferredSlug.slice(0, 40)}-${randomSuffix()}`;
    const [row] = await tx
      .insert(organizations)
      .values({ ...values, slug })
      .onConflictDoNothing({ target: organizations.slug })
      .returning();
    if (row) return row;
    if (explicitSlug) break;
  }
  throw new ConflictError(
    explicitSlug ? 'That organization handle is already taken' : 'Could not allocate a handle',
  );
}

export interface CreatedOrganization {
  organization: Organization;
  ownerMembership: Membership;
}

/**
 * Creates an organization and the creator's membership atomically.
 * Hooks let later phases (RBAC roles, audit, events, billing) join the same transaction.
 */
export async function createOrganization(
  db: Database,
  ownerUserId: string,
  rawInput: CreateOrganizationInput,
  hooks: ((tx: SystemTx, created: CreatedOrganization) => Promise<void>)[] = [],
): Promise<CreatedOrganization> {
  const input = createOrganizationInputSchema.parse(rawInput);
  // System scope: the tenant does not exist yet, so no tenant context can authorize the insert.
  return withSystem(db, async (tx) => {
    const [owner] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, ownerUserId));
    if (owner?.status !== 'active') {
      throw new NotFoundError('User');
    }

    const organization = await insertOrganizationWithUniqueSlug(
      tx,
      {
        name: input.name,
        countryCode: input.countryCode,
        defaultCurrency: input.defaultCurrency,
        timezone: input.timezone,
        locale: input.locale,
        createdByUserId: ownerUserId,
      },
      input.slug ?? slugBaseFromName(input.name),
      input.slug !== undefined,
    );

    const [ownerMembership] = await tx
      .insert(memberships)
      .values({ organizationId: organization.id, userId: ownerUserId, status: 'active' })
      .returning();
    if (!ownerMembership) throw new Error('membership insert returned no row');

    const created = { organization, ownerMembership };
    for (const hook of hooks) {
      await hook(tx, created);
    }
    return created;
  });
}

export interface UserOrganization {
  organization: OrganizationSummary;
  membershipId: string;
}

/** Organizations the user is an active member of (for the organization switcher). */
export async function listOrganizationsForUser(
  db: Database,
  userId: string,
): Promise<UserOrganization[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select({ organization: organizations, membershipId: memberships.id })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
          eq(organizations.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      )
      .orderBy(asc(organizations.name))
      .limit(500);
    return rows.map((row) => ({
      organization: toOrganizationSummary(row.organization),
      membershipId: row.membershipId,
    }));
  });
}

export interface ResolvedMembership {
  organization: Organization;
  membership: Membership;
}

/**
 * Resolves the user's active membership in an organization. Returns null when the user is not
 * an active member, or the organization is inactive/deleted — callers must respond 404 so that
 * organization IDs cannot be probed.
 */
export async function resolveMembership(
  db: Database,
  userId: string,
  organizationId: string,
): Promise<ResolvedMembership | null> {
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .select({ organization: organizations, membership: memberships })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.organizationId, organizationId),
          eq(memberships.status, 'active'),
          eq(organizations.status, 'active'),
          isNull(organizations.deletedAt),
        ),
      );
    return row ?? null;
  });
}

export async function getOrganization(tx: TenantTx, organizationId: string): Promise<Organization> {
  const [row] = await tx
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)));
  if (!row) throw new NotFoundError('Organization');
  return row;
}

export async function updateOrganization(
  tx: TenantTx,
  organizationId: string,
  rawPatch: UpdateOrganizationInput,
): Promise<{ before: Organization; after: Organization }> {
  const patch = updateOrganizationInputSchema.parse(rawPatch);
  const before = await getOrganization(tx, organizationId);
  if (Object.keys(patch).length === 0) return { before, after: before };
  const [after] = await tx
    .update(organizations)
    .set(patch)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .returning();
  if (!after) throw new NotFoundError('Organization');
  return { before, after };
}

export interface MemberSummary {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: Membership['status'];
  joinedAt: Date;
}

const memberCursorSchema = z.object({ name: z.string(), id: z.uuid() });

export async function listMembers(
  tx: TenantTx,
  organizationId: string,
  query: { limit: number; cursor?: string | undefined; search?: string | undefined },
): Promise<Page<MemberSummary>> {
  const conditions = [eq(memberships.organizationId, organizationId)];
  if (query.search) {
    const pattern = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const searchCondition = or(
      sql`${users.name} ILIKE ${pattern}`,
      sql`${users.email} ILIKE ${pattern}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  if (query.cursor) {
    const position = decodeCursor(query.cursor, memberCursorSchema);
    const after = or(
      gt(users.name, position.name),
      and(eq(users.name, position.name), gt(memberships.id, position.id)),
    );
    if (after) conditions.push(after);
  }
  const rows = await tx
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      status: memberships.status,
      joinedAt: memberships.joinedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(...conditions))
    .orderBy(asc(users.name), asc(memberships.id))
    .limit(query.limit + 1);
  return toPage(
    rows,
    query.limit,
    (row) => ({ name: row.name, id: row.membershipId }),
    (row) => row,
  );
}
