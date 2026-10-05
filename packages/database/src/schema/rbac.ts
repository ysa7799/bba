import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, tenantIsolationPolicy, timestamps } from './_helpers';
import { memberships, organizations } from './organizations';

/**
 * Roles per organization. System roles (`system_key` set) take their permissions from code;
 * custom roles store an explicit permission list validated against the catalogue.
 */
export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    systemKey: text(),
    name: text().notNull(),
    description: text().notNull().default(''),
    permissions: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isSystem: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('roles_id_org_unique').on(t.id, t.organizationId),
    uniqueIndex('roles_org_system_key_unique')
      .on(t.organizationId, t.systemKey)
      .where(sql`${t.systemKey} is not null`),
    uniqueIndex('roles_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    check('roles_name_length_check', sql`char_length(${t.name}) between 1 and 100`),
    check('roles_description_length_check', sql`char_length(${t.description}) <= 500`),
    check(
      'roles_system_consistency_check',
      sql`(${t.isSystem} and ${t.systemKey} is not null) or (not ${t.isSystem} and ${t.systemKey} is null)`,
    ),
    check('roles_permissions_size_check', sql`cardinality(${t.permissions}) <= 500`),
    tenantIsolationPolicy(),
  ],
);

/**
 * Role assignments. Composite foreign keys guarantee that the membership and the role belong
 * to the same organization as the assignment (cross-tenant assignment is impossible at the
 * database level). Assigned roles cannot be deleted (RESTRICT).
 */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    membershipId: uuid().notNull(),
    roleId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.roleId] }),
    index('membership_roles_role_idx').on(t.roleId),
    index('membership_roles_org_idx').on(t.organizationId),
    foreignKey({
      name: 'membership_roles_membership_fk',
      columns: [t.membershipId, t.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_roles_role_fk',
      columns: [t.roleId, t.organizationId],
      foreignColumns: [roles.id, roles.organizationId],
    }).onDelete('restrict'),
    tenantIsolationPolicy(),
  ],
);

export type Role = typeof roles.$inferSelect;
export type MembershipRole = typeof membershipRoles.$inferSelect;
