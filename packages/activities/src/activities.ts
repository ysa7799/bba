import {
  activities,
  users,
  type Activity,
  type ActivityActorType,
  type TenantTx,
} from '@businessos/database';
import { isPermission, type Permission } from '@businessos/permissions';
import {
  decodeCursor,
  encodeCursor,
  ForbiddenError,
  NotFoundError,
  paginationQuerySchema,
  redactSensitive,
  ValidationError,
  type Page,
} from '@businessos/shared';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_TYPES,
  activityDefinition,
  isActivityType,
  type ActivityCategory,
  type ActivityType,
  type ActivityTypeDefinition,
} from './registry';

const MAX_METADATA_BYTES = 4_096;
const MAX_SUMMARY = 1_000;

export interface ActivityInput {
  organizationId: string;
  type: ActivityType;
  occurredAt?: Date | undefined;
  actor: { type: ActivityActorType; userId: string | null };
  subject: { type: string; id: string };
  contactId?: string | null | undefined;
  companyId?: string | null | undefined;
  dealId?: string | null | undefined;
  summary: string;
  metadata?: Record<string, unknown> | undefined;
  /** Stricter permission than the type default (e.g. a note on a deal needs deal access). */
  requiredPermission?: Permission | undefined;
  sourceEventId?: string | null | undefined;
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const redacted = redactSensitive(metadata) as Record<string, unknown>;
  if (JSON.stringify(redacted).length <= MAX_METADATA_BYTES) return redacted;
  return { truncated: true };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Appends an activity in the caller's tenant transaction. Projected activities pass the source
 * event id, so redelivered events never create duplicates. Returns null for a duplicate.
 */
export async function recordActivity(tx: TenantTx, input: ActivityInput): Promise<Activity | null> {
  const definition: ActivityTypeDefinition = activityDefinition(input.type);
  if (!input.contactId && !input.companyId && !input.dealId) {
    throw new ValidationError('An activity must concern a contact, company or deal');
  }
  const [row] = await tx
    .insert(activities)
    .values({
      organizationId: input.organizationId,
      type: input.type,
      category: definition.category,
      channel: definition.channel ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      actorType: input.actor.type,
      actorUserId: input.actor.userId,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      requiredPermission: input.requiredPermission ?? definition.permission,
      summary: oneLine(input.summary, MAX_SUMMARY) || input.type,
      metadata: safeMetadata(input.metadata),
      sourceEventId: input.sourceEventId ?? null,
    })
    .onConflictDoNothing({ target: activities.sourceEventId })
    .returning();
  return row ?? null;
}

export interface ActivitySummary {
  id: string;
  type: string;
  category: ActivityCategory;
  channel: string | null;
  occurredAt: string;
  actor: { type: ActivityActorType; userId: string | null; name: string | null };
  subject: { type: string; id: string };
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  manual: boolean;
}

/** API shape of an activity: only the type's declared metadata keys are included. */
export function toActivitySummary(row: Activity, actorName: string | null): ActivitySummary {
  const definition: ActivityTypeDefinition | undefined = isActivityType(row.type)
    ? ACTIVITY_TYPES[row.type]
    : undefined;
  const allowed = new Set(definition?.metadataKeys ?? []);
  const metadata = Object.fromEntries(
    Object.entries(row.metadata).filter(([key]) => allowed.has(key)),
  );
  return {
    id: row.id,
    type: row.type,
    category: row.category as ActivityCategory,
    channel: row.channel,
    occurredAt: row.occurredAt.toISOString(),
    actor: {
      type: row.actorType,
      userId: row.actorUserId,
      name: row.actorUserId ? actorName : null,
    },
    subject: { type: row.subjectType, id: row.subjectId },
    contactId: row.contactId,
    companyId: row.companyId,
    dealId: row.dealId,
    summary: row.summary,
    metadata,
    manual: definition?.manual === true,
  };
}

export const activityListQuerySchema = paginationQuerySchema.extend({
  category: z.enum(ACTIVITY_CATEGORIES).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export type ActivityScope =
  | { kind: 'contact'; id: string }
  | { kind: 'company'; id: string }
  | { kind: 'deal'; id: string }
  | { kind: 'organization' };

const cursorSchema = z.object({ t: z.string().max(64), id: z.uuid() });

/**
 * A timeline, newest first. Only rows whose required permission the caller holds are returned,
 * and only each type's declared metadata keys leave the server.
 */
export async function listActivities(
  tx: TenantTx,
  organizationId: string,
  scope: ActivityScope,
  query: ActivityListQuery,
  permissions: ReadonlySet<string>,
): Promise<Page<ActivitySummary>> {
  const visible = [...permissions].filter(isPermission);
  if (visible.length === 0) return { data: [], nextCursor: null };
  const conditions: SQL[] = [
    eq(activities.organizationId, organizationId),
    inArray(activities.requiredPermission, visible),
  ];
  if (scope.kind === 'contact') conditions.push(eq(activities.contactId, scope.id));
  if (scope.kind === 'company') conditions.push(eq(activities.companyId, scope.id));
  if (scope.kind === 'deal') conditions.push(eq(activities.dealId, scope.id));
  if (query.category) conditions.push(eq(activities.category, query.category));
  if (query.from) conditions.push(gte(activities.occurredAt, new Date(query.from)));
  if (query.to) conditions.push(lte(activities.occurredAt, new Date(query.to)));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorSchema);
    conditions.push(
      sql`(${activities.occurredAt}, ${activities.id}) < (${position.t}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({
      activity: activities,
      actorName: users.name,
      cursorTime: sql<string>`${activities.occurredAt}::text`,
    })
    .from(activities)
    .leftJoin(users, eq(users.id, activities.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(activities.occurredAt), desc(activities.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map((row) => toActivitySummary(row.activity, row.actorName)),
    nextCursor: hasMore && last ? encodeCursor({ t: last.cursorTime, id: last.activity.id }) : null,
  };
}

export async function getActivity(
  tx: TenantTx,
  organizationId: string,
  id: string,
): Promise<Activity> {
  const [row] = await tx
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.organizationId, organizationId)));
  if (!row) throw new NotFoundError('Activity');
  return row;
}

/**
 * Deletes a manually logged activity. Projected activities are the record of what happened and
 * cannot be deleted from the timeline. Authors may delete their own entries; `canModerate`
 * allows any. Callers without the row's required permission get 404.
 */
export async function deleteLoggedActivity(
  tx: TenantTx,
  organizationId: string,
  id: string,
  actor: { userId: string; permissions: ReadonlySet<string>; canModerate: boolean },
): Promise<Activity> {
  const row = await getActivity(tx, organizationId, id);
  if (!actor.permissions.has(row.requiredPermission)) throw new NotFoundError('Activity');
  const definition: ActivityTypeDefinition | undefined = isActivityType(row.type)
    ? ACTIVITY_TYPES[row.type]
    : undefined;
  if (definition?.manual !== true)
    throw new ForbiddenError('Only logged activities can be deleted');
  if (!actor.canModerate && row.actorUserId !== actor.userId) {
    throw new ForbiddenError('You can only delete activities you logged');
  }
  await tx
    .delete(activities)
    .where(and(eq(activities.id, id), eq(activities.organizationId, organizationId)));
  return row;
}
