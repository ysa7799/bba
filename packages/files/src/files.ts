import { assertWithinLimit } from '@businessos/billing';
import { assertCompanyExists, assertContactExists, assertDealExists } from '@businessos/crm';
import {
  files,
  users,
  withSystem,
  withTenant,
  type Database,
  type FileEntityType,
  type FileRecord,
  type TenantTx,
} from '@businessos/database';
import type { Permission } from '@businessos/permissions';
import {
  NotFoundError,
  PayloadTooLargeError,
  ProviderError,
  ValidationError,
  newId,
} from '@businessos/shared';
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { isInlineType, nameForType, sanitizeName, sniffType } from './sniff';
import type { FileStorage } from './storage';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface FileServices {
  db: Database;
  storage: FileStorage;
  logger?: { warn: (obj: object, msg: string) => void };
}

/** Who may see and change the files of each kind of record. */
export const ENTITY_PERMISSIONS: Record<FileEntityType, { read: Permission; write: Permission }> = {
  contact: { read: 'crm.contact.read', write: 'crm.contact.update' },
  company: { read: 'crm.company.read', write: 'crm.company.update' },
  deal: { read: 'crm.deal.read', write: 'crm.deal.update' },
};

export interface FileEntity {
  type: FileEntityType;
  id: string;
}

export interface FileView {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: string;
  entityType: FileEntityType | null;
  entityId: string | null;
  uploadedBy: { id: string; name: string } | null;
  /** Images can be previewed in the browser; everything else downloads. */
  inline: boolean;
  createdAt: string;
}

interface Scope {
  organizationId: string;
  userId: string | null;
}

async function assertEntity(tx: TenantTx, organizationId: string, entity: FileEntity) {
  try {
    if (entity.type === 'contact') await assertContactExists(tx, organizationId, entity.id);
    else if (entity.type === 'company') await assertCompanyExists(tx, organizationId, entity.id);
    else await assertDealExists(tx, organizationId, entity.id);
  } catch {
    throw new NotFoundError('Record');
  }
}

async function views(tx: TenantTx, rows: FileRecord[]): Promise<FileView[]> {
  const uploaderIds = [
    ...new Set(rows.map((row) => row.uploadedByUserId).filter((id): id is string => id !== null)),
  ];
  const uploaders =
    uploaderIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, uploaderIds));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes.toString(),
    entityType: row.entityType,
    entityId: row.entityId,
    uploadedBy: uploaders.find((user) => user.id === row.uploadedByUserId) ?? null,
    inline: isInlineType(row.contentType),
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Bytes counted against `storage.bytes` (files being uploaded count already). */
export async function storageUsedBytes(tx: TenantTx, organizationId: string): Promise<bigint> {
  const [row] = await tx
    .select({ used: sql<string>`coalesce(sum(${files.sizeBytes}), 0)::text` })
    .from(files)
    .where(
      and(eq(files.organizationId, organizationId), inArray(files.status, ['pending', 'ready'])),
    );
  return BigInt(row?.used ?? '0');
}

/**
 * Stores an upload: validates size and real type, reserves its bytes in the quota (under an
 * organization lock, so parallel uploads cannot overrun it), writes the object, then marks the
 * file ready. A failed write removes the reservation.
 */
export async function uploadFile(
  services: FileServices,
  scope: Scope,
  input: { name: string; body: Buffer; entity?: FileEntity | null },
): Promise<FileView> {
  if (input.body.length === 0) {
    throw new ValidationError('The file is empty', [{ path: 'file', message: 'Empty file' }]);
  }
  if (input.body.length > MAX_FILE_BYTES) throw new PayloadTooLargeError('The file is too large');
  const cleaned = sanitizeName(input.name);
  const contentType = sniffType(input.body, cleaned);
  if (!contentType) {
    throw new ValidationError('This type of file is not allowed', [
      { path: 'file', message: 'Allowed: images, PDF, text, CSV and Office documents' },
    ]);
  }
  // Downloads are saved under this name, so its extension must say what the file really is.
  const name = nameForType(cleaned, contentType);
  const id = newId();
  const storageKey = `${scope.organizationId}/${id}`;
  const sha256 = createHash('sha256').update(input.body).digest('hex');
  await withTenant(services.db, scope, async (tx) => {
    if (input.entity) await assertEntity(tx, scope.organizationId, input.entity);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`files:${scope.organizationId}`}, 0))`,
    );
    const used = await storageUsedBytes(tx, scope.organizationId);
    const projected = used + BigInt(input.body.length);
    await assertWithinLimit(
      tx,
      scope.organizationId,
      'storage.bytes',
      // Exact integers far below 2^53 for any plan limit; compared as numbers by the billing API.
      Number(projected),
    );
    await tx.insert(files).values({
      id,
      organizationId: scope.organizationId,
      entityType: input.entity?.type ?? null,
      entityId: input.entity?.id ?? null,
      name,
      contentType,
      sizeBytes: BigInt(input.body.length),
      sha256,
      storageKey,
      status: 'pending',
      uploadedByUserId: scope.userId,
    });
  });
  try {
    await services.storage.put(storageKey, input.body, contentType);
  } catch (error) {
    await withTenant(services.db, scope, (tx) =>
      tx.delete(files).where(and(eq(files.id, id), eq(files.organizationId, scope.organizationId))),
    );
    throw error instanceof ProviderError
      ? error
      : new ProviderError(services.storage.name, 'Could not store the file', { cause: error });
  }
  return withTenant(services.db, scope, async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(and(eq(files.id, id), eq(files.organizationId, scope.organizationId)))
      .returning();
    if (!row) throw new NotFoundError('File');
    const [view] = await views(tx, [row]);
    if (!view) throw new NotFoundError('File');
    return view;
  });
}

export async function listFiles(
  tx: TenantTx,
  organizationId: string,
  entity: FileEntity,
  limit = 100,
): Promise<FileView[]> {
  const rows = await tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.organizationId, organizationId),
        eq(files.entityType, entity.type),
        eq(files.entityId, entity.id),
        eq(files.status, 'ready'),
      ),
    )
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return views(tx, rows);
}

/** A ready file of the organization (any other id, status or tenant is "not found"). */
export async function getFileRow(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<FileRecord> {
  const [row] = await tx
    .select()
    .from(files)
    .where(
      and(eq(files.id, id), eq(files.organizationId, organizationId), eq(files.status, 'ready')),
    );
  if (!row) throw new NotFoundError('File');
  return row;
}

export async function readFileContent(services: FileServices, row: FileRecord): Promise<Buffer> {
  const body = await services.storage.get(row.storageKey);
  // The stored bytes must still be the uploaded ones.
  if (createHash('sha256').update(body).digest('hex') !== row.sha256) {
    throw new ProviderError(services.storage.name, 'The stored file is damaged');
  }
  return body;
}

/** Removes a file: hidden at once, its bytes released from the quota, the object deleted. */
export async function deleteFile(services: FileServices, scope: Scope, id: string): Promise<void> {
  const row = await withTenant(services.db, scope, async (tx) => {
    const current = await getFileRow(tx, scope.organizationId, id);
    await tx
      .update(files)
      .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(files.id, id), eq(files.organizationId, scope.organizationId)));
    return current;
  });
  try {
    await services.storage.delete(row.storageKey);
    await withTenant(services.db, scope, (tx) =>
      tx
        .update(files)
        .set({ purgedAt: new Date() })
        .where(and(eq(files.id, id), eq(files.organizationId, scope.organizationId))),
    );
  } catch (error) {
    // The maintenance job retries; the file is already invisible and out of the quota.
    services.logger?.warn(
      { fileId: id, error: error instanceof Error ? error.message : 'unknown' },
      'file object deletion deferred',
    );
  }
}

/**
 * Upkeep (worker): uploads abandoned for an hour are removed, and objects of deleted files
 * whose removal failed are retried.
 */
export async function runFilesMaintenance(
  services: FileServices,
  now: Date = new Date(),
): Promise<{ abandoned: number; purged: number }> {
  // System scope: maintenance runs across organizations; each change is scoped by its row id.
  const { abandoned, deleted } = await withSystem(services.db, async (tx) => ({
    abandoned: await tx
      .select()
      .from(files)
      .where(
        and(eq(files.status, 'pending'), lt(files.updatedAt, new Date(now.getTime() - 3_600_000))),
      )
      .limit(200),
    deleted: await tx
      .select()
      .from(files)
      .where(and(eq(files.status, 'deleted'), isNull(files.purgedAt)))
      .limit(200),
  }));
  let purged = 0;
  for (const row of [...abandoned, ...deleted]) {
    try {
      await services.storage.delete(row.storageKey);
    } catch {
      continue;
    }
    // System scope: see above.
    await withSystem(services.db, (tx) =>
      row.status === 'pending'
        ? tx.delete(files).where(and(eq(files.id, row.id), eq(files.status, 'pending')))
        : tx.update(files).set({ purgedAt: now }).where(eq(files.id, row.id)),
    );
    if (row.status === 'deleted') purged += 1;
  }
  return { abandoned: abandoned.length, purged };
}
