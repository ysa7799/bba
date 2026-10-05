import {
  notificationPreferences,
  notifications,
  type Notification,
  type TenantTx,
} from '@businessos/database';
import type { Permission } from '@businessos/permissions';
import { decodeCursor, encodeCursor, NotFoundError, ValidationError } from '@businessos/shared';
import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  isNotificationType,
  NOTIFICATION_TYPE_KEYS,
  NOTIFICATION_TYPES,
  type NotificationType,
} from './catalogue';

/** A member in an organization: notifications are always theirs alone. */
export interface NotificationScope {
  organizationId: string;
  userId: string;
}

export const notificationListQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const preferencesInputSchema = z.object({
  preferences: z
    .array(z.object({ type: z.string().max(60), inApp: z.boolean(), email: z.boolean() }))
    .max(50),
});

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function view(row: Notification): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const own = (scope: NotificationScope) =>
  and(
    eq(notifications.organizationId, scope.organizationId),
    eq(notifications.userId, scope.userId),
  );

export async function countUnread(tx: TenantTx, scope: NotificationScope): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(and(own(scope), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

export async function listNotifications(
  tx: TenantTx,
  scope: NotificationScope,
  rawQuery: z.input<typeof notificationListQuerySchema>,
): Promise<{ data: NotificationView[]; nextCursor: string | null; unread: number }> {
  const query = notificationListQuerySchema.parse(rawQuery);
  const conditions: (SQL | undefined)[] = [own(scope)];
  if (query.unread) conditions.push(isNull(notifications.readAt));
  if (query.cursor) {
    const position = decodeCursor(query.cursor, z.object({ v: z.string().max(40), id: z.uuid() }));
    conditions.push(
      sql`(${notifications.createdAt}, ${notifications.id}) < (${position.v}::timestamptz, ${position.id}::uuid)`,
    );
  }
  const rows = await tx
    .select({ row: notifications, sortValue: sql<string>`${notifications.createdAt}::text` })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((entry) => view(entry.row)),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ v: last.sortValue, id: last.row.id })
        : null,
    unread: await countUnread(tx, scope),
  };
}

export async function markRead(
  tx: TenantTx,
  scope: NotificationScope,
  id: string,
): Promise<NotificationView> {
  const [row] = await tx
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(own(scope), eq(notifications.id, id)))
    .returning();
  if (!row) throw new NotFoundError('Notification');
  return view(row);
}

export async function markAllRead(tx: TenantTx, scope: NotificationScope): Promise<number> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(own(scope), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

export interface PreferenceView {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
}

/** The member's channels for every type they can receive (types they cannot are not listed). */
export async function getPreferences(
  tx: TenantTx,
  scope: NotificationScope,
  permissions: ReadonlySet<Permission>,
): Promise<PreferenceView[]> {
  const stored = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.organizationId, scope.organizationId),
        eq(notificationPreferences.userId, scope.userId),
      ),
    );
  return NOTIFICATION_TYPE_KEYS.filter((type) =>
    permissions.has(NOTIFICATION_TYPES[type].permission),
  ).map((type) => {
    const row = stored.find((entry) => entry.type === type);
    const defaults = NOTIFICATION_TYPES[type].defaults;
    return { type, inApp: row?.inApp ?? defaults.inApp, email: row?.email ?? defaults.email };
  });
}

export async function updatePreferences(
  tx: TenantTx,
  scope: NotificationScope,
  permissions: ReadonlySet<Permission>,
  rawInput: z.input<typeof preferencesInputSchema>,
): Promise<PreferenceView[]> {
  const input = preferencesInputSchema.parse(rawInput);
  const problems = input.preferences.flatMap((entry, index) =>
    isNotificationType(entry.type) && permissions.has(NOTIFICATION_TYPES[entry.type].permission)
      ? []
      : [{ path: `preferences.${index}.type`, message: 'Unknown notification type' }],
  );
  if (problems.length > 0) throw new ValidationError('Invalid preferences', problems);
  for (const entry of input.preferences) {
    await tx
      .insert(notificationPreferences)
      .values({
        organizationId: scope.organizationId,
        userId: scope.userId,
        type: entry.type,
        inApp: entry.inApp,
        email: entry.email,
      })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.organizationId,
          notificationPreferences.userId,
          notificationPreferences.type,
        ],
        set: { inApp: entry.inApp, email: entry.email, updatedAt: new Date() },
      });
  }
  return getPreferences(tx, scope, permissions);
}
