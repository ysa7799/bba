import { notifications, withSystem, type Database } from '@businessos/database';
import { and, inArray, isNotNull, lt, or } from 'drizzle-orm';

const DAY_MS = 86_400_000;
/** Read notifications are kept this long; unread ones up to `UNREAD_RETENTION_DAYS`. */
export const READ_RETENTION_DAYS = 90;
export const UNREAD_RETENTION_DAYS = 365;
const BATCH = 2_000;
const MAX_BATCHES = 10;

/**
 * Retention (worker): removes old notifications in bounded batches so the table does not grow
 * without limit. Returns how many were removed.
 */
export async function pruneNotifications(db: Database, now: Date = new Date()): Promise<number> {
  const readBefore = new Date(now.getTime() - READ_RETENTION_DAYS * DAY_MS);
  const anyBefore = new Date(now.getTime() - UNREAD_RETENTION_DAYS * DAY_MS);
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    // System scope: retention applies to every organization's notifications alike.
    const count = await withSystem(db, async (tx) => {
      const expired = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          or(
            lt(notifications.createdAt, anyBefore),
            and(isNotNull(notifications.readAt), lt(notifications.createdAt, readBefore)),
          ),
        )
        .limit(BATCH);
      if (expired.length === 0) return 0;
      await tx.delete(notifications).where(
        inArray(
          notifications.id,
          expired.map((row) => row.id),
        ),
      );
      return expired.length;
    });
    removed += count;
    if (count < BATCH) break;
  }
  return removed;
}
