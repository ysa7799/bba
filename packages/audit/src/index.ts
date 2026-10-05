import {
  auditLogs,
  type AuditActorType,
  type AuditLog,
  type TenantTx,
  type Tx,
} from '@businessos/database';
import { decodeCursor, redactSensitive, toPage, type Page } from '@businessos/shared';
import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Audited actions. Keep names stable: they are part of the compliance record.
 */
export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.email_verified',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'auth.password_changed',
  'organization.created',
  'organization.updated',
  'organization.settings_updated',
  'member.invited',
  'member.invitation_revoked',
  'member.joined',
  'member.roles_changed',
  'member.suspended',
  'member.reactivated',
  'member.removed',
  'member.left',
  'role.created',
  'role.updated',
  'role.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Who did it and from where; built once per request or job. */
export interface AuditContext {
  actorType: AuditActorType;
  actorUserId: string | null;
  actorLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const SYSTEM_AUDIT_CONTEXT: AuditContext = {
  actorType: 'system',
  actorUserId: null,
  actorLabel: 'system',
  ipAddress: null,
  userAgent: null,
  requestId: null,
};

export interface AuditEntry {
  organizationId: string | null;
  action: AuditAction;
  target?: { type: string; id: string } | undefined;
  metadata?: Record<string, unknown> | undefined;
}

const MAX_METADATA_BYTES = 8_192;

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const redacted = redactSensitive(metadata) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= MAX_METADATA_BYTES) return redacted;
  return { truncated: true, keys: Object.keys(redacted).slice(0, 50) };
}

function safeIp(value: string | null): string | null {
  return value && /^[0-9a-fA-F:.]{2,45}$/.test(value) ? value : null;
}

/**
 * Appends an audit record inside the caller's transaction, so the record exists exactly when
 * the audited change committed. Metadata is redacted and size-capped; secrets never belong here.
 */
export async function recordAudit(tx: Tx, context: AuditContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    organizationId: entry.organizationId,
    actorType: context.actorType,
    actorUserId: context.actorUserId,
    actorLabel: context.actorLabel?.slice(0, 320) ?? null,
    action: entry.action,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    metadata: safeMetadata(entry.metadata),
    ipAddress: safeIp(context.ipAddress),
    userAgent: context.userAgent?.slice(0, 512) ?? null,
    requestId: context.requestId?.slice(0, 128) ?? null,
  });
}

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditLogEntry {
  id: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorLabel: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: Date;
}

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

function toEntry(row: AuditLog): AuditLogEntry {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    requestId: row.requestId,
    createdAt: row.createdAt,
  };
}

/** Newest-first audit trail for one organization (keyset pagination). */
export async function listAuditLogs(
  tx: TenantTx,
  organizationId: string,
  query: AuditQuery,
): Promise<Page<AuditLogEntry>> {
  const conditions = [eq(auditLogs.organizationId, organizationId)];
  if (query.action) conditions.push(eq(auditLogs.action, query.action));
  if (query.actorUserId) conditions.push(eq(auditLogs.actorUserId, query.actorUserId));
  if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
  if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    const createdAt = new Date(position.createdAt);
    const before = or(
      lt(auditLogs.createdAt, createdAt),
      and(eq(auditLogs.createdAt, createdAt), lt(auditLogs.id, position.id)),
    );
    if (before) conditions.push(before);
  }
  const rows = await tx
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(query.limit + 1);
  return toPage(
    rows,
    query.limit,
    (row) => ({ createdAt: row.createdAt.toISOString(), id: row.id }),
    toEntry,
  );
}
