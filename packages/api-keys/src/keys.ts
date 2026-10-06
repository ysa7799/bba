import {
  apiKeys,
  users,
  withSystem,
  type ApiKey,
  type Database,
  type Organization,
  type TenantTx,
} from '@businessos/database';
import { resolveMembership } from '@businessos/organizations';
import type { Permission } from '@businessos/permissions';
import { ConflictError, ForbiddenError, NotFoundError } from '@businessos/shared';
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * What a key may be allowed to do: the public API's operations, named by the permission each
 * one requires. A key's scopes are always a subset of these and of its creator's permissions.
 */
export const PUBLIC_API_SCOPES = [
  'crm.contact.read',
  'crm.contact.create',
  'crm.contact.update',
  'crm.contact.delete',
  'crm.company.read',
  'crm.company.create',
  'crm.company.update',
  'crm.company.delete',
  'crm.deal.read',
  'crm.deal.create',
  'crm.deal.update',
  'crm.deal.delete',
  'crm.task.read',
  'crm.task.manage',
  'commerce.invoice.read',
] as const satisfies readonly Permission[];
export type ApiScope = (typeof PUBLIC_API_SCOPES)[number];

/** Live (not revoked) keys an organization may hold at once. */
export const MAX_ACTIVE_KEYS = 25;
const KEY_PATTERN = /^bos_[A-Za-z0-9_-]{43}$/;
/** `last_used_at` is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** A new random key (256 bits), its display prefix and its hash. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `bos_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(PUBLIC_API_SCOPES))
    .min(1)
    .max(PUBLIC_API_SCOPES.length)
    .transform((scopes) => [...new Set(scopes)]),
  /** Days until the key stops working; omitted or null for no expiry. */
  expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
});
export type CreateApiKeyInput = z.input<typeof createApiKeyInputSchema>;

export type ApiKeyStatus = 'active' | 'expired' | 'revoked';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: ApiKeyStatus;
  createdBy: { id: string; name: string } | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function statusOf(row: ApiKey, now: Date): ApiKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

async function views(tx: TenantTx, rows: ApiKey[]): Promise<ApiKeyView[]> {
  const creatorIds = [
    ...new Set(rows.map((row) => row.createdByUserId).filter((id): id is string => id !== null)),
  ];
  const creators =
    creatorIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, creatorIds));
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    status: statusOf(row, now),
    createdBy: creators.find((user) => user.id === row.createdByUserId) ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface KeyManager {
  organizationId: string;
  userId: string;
  /** The creator's permissions: a key can never do more than the person who made it. */
  permissions: ReadonlySet<Permission>;
}

/**
 * Creates a key and returns it **once**; only its hash is stored. Scopes the creator does not
 * hold are refused (no escalation through keys).
 */
export async function createApiKey(
  tx: TenantTx,
  manager: KeyManager,
  rawInput: CreateApiKeyInput,
): Promise<{ apiKey: ApiKeyView; key: string }> {
  const input = createApiKeyInputSchema.parse(rawInput);
  const beyond = input.scopes.filter((scope) => !manager.permissions.has(scope));
  if (beyond.length > 0) {
    throw new ForbiddenError(`You cannot grant permissions you do not hold: ${beyond.join(', ')}`);
  }
  // Serializes key creation per organization so the active-key limit holds under concurrency.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`api_keys:${manager.organizationId}`}, 0))`,
  );
  const [active] = await tx
    .select({ n: count() })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, manager.organizationId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > now()`),
      ),
    );
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new ConflictError(
      `An organization can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`,
    );
  }
  const generated = generateApiKey();
  const [row] = await tx
    .insert(apiKeys)
    .values({
      organizationId: manager.organizationId,
      name: input.name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scopes: input.scopes,
      createdByUserId: manager.userId,
      expiresAt:
        input.expiresInDays === null || input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000),
    })
    .returning();
  if (!row) throw new Error('API key was not created');
  const [view] = await views(tx, [row]);
  if (!view) throw new Error('API key was not created');
  return { apiKey: view, key: generated.key };
}

/** The organization's keys, newest first (revoked and expired ones included, for the record). */
export async function listApiKeys(tx: TenantTx, organizationId: string): Promise<ApiKeyView[]> {
  const rows = await tx
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, organizationId))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(100);
  return views(tx, rows);
}

/** Revokes a key at once (idempotent). */
export async function revokeApiKey(
  tx: TenantTx,
  organizationId: string,
  id: string,
  userId: string,
): Promise<ApiKeyView> {
  await tx
    .update(apiKeys)
    .set({ revokedAt: new Date(), revokedByUserId: userId, updatedAt: new Date() })
    .where(
      and(
        eq(apiKeys.organizationId, organizationId),
        eq(apiKeys.id, id),
        isNull(apiKeys.revokedAt),
      ),
    );
  const [row] = await tx
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.id, id)));
  if (!row) throw new NotFoundError('API key');
  const [view] = await views(tx, [row]);
  if (!view) throw new NotFoundError('API key');
  return view;
}

/** Who is calling: resolved from the key, never from anything else in the request. */
export interface ApiCaller {
  apiKeyId: string;
  organizationId: string;
  organization: Organization;
  name: string;
  prefix: string;
  /** The key's scopes that its creator still holds right now. */
  scopes: ReadonlySet<ApiScope>;
}

/**
 * Resolves a presented key to its organization and scopes, or null when it is malformed,
 * unknown, revoked or expired, its organization is not active, or its creator is no longer an
 * active member. A key never does more than its creator could do now: its scopes are narrowed
 * to the creator's current permissions on every request.
 */
export async function authenticateApiKey(
  db: Database,
  presented: string,
  now: Date = new Date(),
): Promise<ApiCaller | null> {
  if (!KEY_PATTERN.test(presented)) return null;
  const hash = hashApiKey(presented);
  // System scope: the key is what identifies the tenant, so the lookup precedes any tenant
  // context (like a session lookup). It matches on the hash of a 256-bit secret only.
  const [key] = await withSystem(db, (tx) =>
    tx.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)),
  );
  if (!key || statusOf(key, now) !== 'active' || !key.createdByUserId) return null;
  // Also requires the organization to be active.
  const creator = await resolveMembership(db, key.createdByUserId, key.organizationId);
  if (!creator) return null;
  if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    // System scope: bookkeeping on the row just authenticated (by id), throttled.
    await withSystem(db, (tx) =>
      tx
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, key.id),
            or(
              isNull(apiKeys.lastUsedAt),
              lt(apiKeys.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
            ),
          ),
        ),
    );
  }
  const known = new Set<string>(PUBLIC_API_SCOPES);
  const held: ReadonlySet<string> = creator.access.permissions;
  return {
    apiKeyId: key.id,
    organizationId: key.organizationId,
    organization: creator.organization,
    name: key.name,
    prefix: key.prefix,
    scopes: new Set(
      key.scopes.filter((scope): scope is ApiScope => known.has(scope) && held.has(scope)),
    ),
  };
}

/** The key in an `Authorization: Bearer <key>` header, or null. */
export function bearerKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  return /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] ?? null;
}
