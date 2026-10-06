import { apiIdempotencyKeys, withSystem, withTenant, type Database } from '@businessos/database';
import { ConflictError, UnprocessableError, ValidationError } from '@businessos/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';

/** How long a result is replayed for the same key. */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000;
/** A request still "processing" after this long is treated as abandoned (a crashed server). */
const ABANDONED_AFTER_MS = 2 * 60_000;
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface IdempotencyScope {
  organizationId: string;
  apiKeyId: string;
}

/** Fingerprint of a request: a key reused for a different request is refused. */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

export function parseIdempotencyKey(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new ValidationError('Invalid Idempotency-Key', [
      { path: 'idempotency-key', message: 'Use 1–255 printable characters (a UUID is ideal)' },
    ]);
  }
  return raw;
}

export type IdempotencyStart =
  { kind: 'new'; id: string } | { kind: 'replay'; status: number; body: unknown };

/**
 * Claims an idempotency key for a request. A completed earlier request with the same key and
 * the same request is replayed; a different request with the key is refused (422); one still
 * in progress is a conflict (409).
 */
export async function beginIdempotentRequest(
  db: Database,
  scope: IdempotencyScope,
  key: string,
  fingerprint: string,
  now: Date = new Date(),
): Promise<IdempotencyStart> {
  return withTenant(db, { organizationId: scope.organizationId, userId: null }, async (tx) => {
    // Results older than the window no longer count.
    await tx
      .delete(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, scope.organizationId),
          eq(apiIdempotencyKeys.apiKeyId, scope.apiKeyId),
          eq(apiIdempotencyKeys.key, key),
          lt(apiIdempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS)),
        ),
      );
    const [claimed] = await tx
      .insert(apiIdempotencyKeys)
      .values({
        organizationId: scope.organizationId,
        apiKeyId: scope.apiKeyId,
        key,
        requestHash: fingerprint,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: apiIdempotencyKeys.id });
    if (claimed) return { kind: 'new', id: claimed.id };

    const [existing] = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, scope.organizationId),
          eq(apiIdempotencyKeys.apiKeyId, scope.apiKeyId),
          eq(apiIdempotencyKeys.key, key),
        ),
      )
      .for('update');
    if (!existing) throw new ConflictError('The request with this Idempotency-Key is in progress');
    if (existing.requestHash !== fingerprint) {
      throw new UnprocessableError('This Idempotency-Key was already used for a different request');
    }
    if (existing.status === 'completed') {
      return {
        kind: 'replay',
        status: existing.responseStatus ?? 200,
        body: existing.responseBody,
      };
    }
    if (existing.createdAt.getTime() < now.getTime() - ABANDONED_AFTER_MS) {
      // The earlier attempt died mid-way (its transaction rolled back): take it over.
      await tx
        .update(apiIdempotencyKeys)
        .set({ createdAt: now })
        .where(eq(apiIdempotencyKeys.id, existing.id));
      return { kind: 'new', id: existing.id };
    }
    throw new ConflictError('The request with this Idempotency-Key is still in progress');
  });
}

/** Stores the successful result so retries with the same key get the same answer. */
export async function completeIdempotentRequest(
  db: Database,
  scope: IdempotencyScope,
  id: string,
  status: number,
  body: unknown,
): Promise<void> {
  await withTenant(db, { organizationId: scope.organizationId, userId: null }, (tx) =>
    tx
      .update(apiIdempotencyKeys)
      .set({ status: 'completed', responseStatus: status, responseBody: body ?? null })
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, scope.organizationId),
          eq(apiIdempotencyKeys.id, id),
        ),
      ),
  );
}

/** Releases a key whose request failed, so the client can retry it. */
export async function releaseIdempotentRequest(
  db: Database,
  scope: IdempotencyScope,
  id: string,
): Promise<void> {
  await withTenant(db, { organizationId: scope.organizationId, userId: null }, (tx) =>
    tx
      .delete(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.organizationId, scope.organizationId),
          eq(apiIdempotencyKeys.id, id),
          eq(apiIdempotencyKeys.status, 'processing'),
        ),
      ),
  );
}

/** Retention (worker): removes records past the replay window, in bounded batches. */
export async function pruneIdempotencyKeys(db: Database, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS);
  // System scope: retention applies to every organization alike.
  const rows = await withSystem(db, (tx) =>
    tx.execute<{ id: string }>(sql`
      delete from ${apiIdempotencyKeys}
      where ${apiIdempotencyKeys.id} in (
        select ${apiIdempotencyKeys.id} from ${apiIdempotencyKeys}
        where ${apiIdempotencyKeys.createdAt} < ${cutoff}
        limit 5000
      )
      returning ${apiIdempotencyKeys.id}`),
  );
  return rows.rows.length;
}
