import { isUuid, InternalError } from '@businessos/shared';
import { sql } from 'drizzle-orm';
import type { Database } from './client';

/** A Drizzle transaction handle. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

declare const tenantBrand: unique symbol;
declare const userBrand: unique symbol;
declare const systemBrand: unique symbol;

/**
 * A transaction scoped to one organization: RLS restricts every statement to that tenant.
 * The brand prevents passing an unscoped or system transaction where tenant scope is required.
 */
export type TenantTx = Tx & { readonly [tenantBrand]: true };

/** A transaction scoped to one user (no organization): own profile, own memberships. */
export type UserTx = Tx & { readonly [userBrand]: true };

/** A transaction that bypasses tenant RLS. Use only where justified (see ARCHITECTURE §3). */
export type SystemTx = Tx & { readonly [systemBrand]: true };

export interface TenantScope {
  readonly organizationId: string;
  /** Acting user, when the work is performed on behalf of a person. */
  readonly userId: string | null;
}

export interface TransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new InternalError(`Invalid ${label} for scoped transaction`);
  }
}

/**
 * Runs `fn` in a transaction where Postgres RLS limits all tenant tables to
 * `scope.organizationId`. Settings are transaction-local and never leak across pooled
 * connections.
 */
export async function withTenant<T>(
  db: Database,
  scope: TenantScope,
  fn: (tx: TenantTx) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  assertUuid(scope.organizationId, 'organization id');
  if (scope.userId !== null) assertUuid(scope.userId, 'user id');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', ${scope.organizationId}, true),
                 set_config('app.user_id', ${scope.userId ?? ''}, true),
                 set_config('app.system', '', true)`,
    );
    return fn(tx as TenantTx);
  }, options);
}

/** Runs `fn` scoped to a single user without an organization (e.g. listing own organizations). */
export async function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: UserTx) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  assertUuid(userId, 'user id');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', '', true),
                 set_config('app.user_id', ${userId}, true),
                 set_config('app.system', '', true)`,
    );
    return fn(tx as UserTx);
  }, options);
}

/**
 * Runs `fn` with RLS bypassed for tenant tables. Reserved for: authentication (global
 * identity tables), routing inbound webhooks to a tenant, workers before the tenant is known,
 * organization creation, migrations/seeds and platform administration. Every call site must
 * carry a comment explaining why system scope is required.
 */
export async function withSystem<T>(
  db: Database,
  fn: (tx: SystemTx) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.org_id', '', true),
                 set_config('app.user_id', '', true),
                 set_config('app.system', 'on', true)`,
    );
    return fn(tx as SystemTx);
  }, options);
}

/** Postgres SQLSTATE codes we translate into domain errors. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  exclusionViolation: '23P01',
  insufficientPrivilege: '42501',
} as const;

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/** Returns the SQLSTATE and constraint of a (possibly wrapped) Postgres error. */
export function pgErrorInfo(error: unknown): { code: string; constraint: string | null } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as PgErrorLike;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
      };
    }
    current = candidate.cause;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error);
  return (
    info?.code === PG_ERROR.uniqueViolation &&
    (constraint === undefined || info.constraint === constraint)
  );
}
