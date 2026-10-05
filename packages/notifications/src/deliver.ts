import {
  notificationPreferences,
  notifications,
  users,
  withTenant,
  type Database,
} from '@businessos/database';
import type { DomainEvent, EventSubscriber } from '@businessos/events';
import { resolveMembership } from '@businessos/organizations';
import { and, eq } from 'drizzle-orm';
import { BUILDERS } from './build';
import { NOTIFICATION_EVENTS, NOTIFICATION_TYPES } from './catalogue';

export interface NotificationServices {
  db: Database;
  /** Public web app URL (links in emails). */
  appUrl: string;
  /** Queues the `notification` email (the job id makes redelivery harmless). */
  enqueueEmail(
    payload: { to: string; data: Record<string, string | null> },
    jobId: string,
    correlationId: string | null,
  ): Promise<void>;
}

/**
 * Turns one domain event into notifications. Every recipient is re-checked at delivery: still
 * an active member, still holding the type's permission, not the person who acted, and their
 * channel choices. Safe to run again for the same event (unique per member, type and event;
 * deterministic email job ids).
 */
export async function deliverNotifications(
  services: NotificationServices,
  event: DomainEvent,
): Promise<{ delivered: number; emailed: number }> {
  const builder = BUILDERS[event.type];
  const organizationId = event.organizationId;
  if (!builder || !organizationId) return { delivered: 0, emailed: 0 };
  // The event's own tenant, without a user: reads the subject to word the notification.
  const drafts = await withTenant(services.db, { organizationId, userId: null }, (tx) =>
    builder(tx, event),
  );
  let delivered = 0;
  let emailed = 0;
  for (const draft of drafts) {
    const definition = NOTIFICATION_TYPES[draft.type];
    for (const recipient of new Set(draft.recipients)) {
      if (event.actor.type === 'user' && event.actor.id === recipient) continue;
      const membership = await resolveMembership(services.db, recipient, organizationId);
      if (!membership?.access.permissions.has(definition.permission)) continue;
      const link = `/o/${organizationId}/${draft.path}`;
      // The recipient's own scope: notifications and preferences are private to them.
      const result = await withTenant(
        services.db,
        { organizationId, userId: recipient },
        async (tx) => {
          const [preference] = await tx
            .select()
            .from(notificationPreferences)
            .where(
              and(
                eq(notificationPreferences.organizationId, organizationId),
                eq(notificationPreferences.userId, recipient),
                eq(notificationPreferences.type, draft.type),
              ),
            );
          const channels = preference ?? definition.defaults;
          let created = false;
          if (channels.inApp) {
            const inserted = await tx
              .insert(notifications)
              .values({
                organizationId,
                userId: recipient,
                type: draft.type,
                title: draft.title,
                body: draft.body,
                link,
                subjectType: draft.subject.type,
                subjectId: draft.subject.id,
                sourceEventId: event.id,
              })
              .onConflictDoNothing()
              .returning({ id: notifications.id });
            created = inserted.length > 0;
          }
          const [user] = channels.email
            ? await tx
                .select({ email: users.email, name: users.name, status: users.status })
                .from(users)
                .where(eq(users.id, recipient))
            : [];
          return { created, email: user?.status === 'active' ? user : null };
        },
      );
      if (result.created) delivered += 1;
      if (result.email) {
        await services.enqueueEmail(
          {
            to: result.email.email,
            data: {
              name: result.email.name,
              organization: membership.organization.name,
              title: draft.title,
              body: draft.body,
              link: `${services.appUrl.replace(/\/+$/, '')}${link}`,
            },
          },
          `notification-${draft.type.replace('.', '-')}-${event.id}-${recipient}`,
          event.correlationId,
        );
        emailed += 1;
      }
    }
  }
  return { delivered, emailed };
}

export function createNotificationSubscriber(services: NotificationServices): EventSubscriber {
  return {
    name: 'notifications',
    events: NOTIFICATION_EVENTS,
    handle: async (event) => {
      await deliverNotifications(services, event);
    },
  };
}
