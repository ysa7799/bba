import { createTimelineSubscriber } from '@businessos/activities';
import { createAutomationSubscriber, type AutomationServices } from '@businessos/automation';
import { calendarTimelineProjectors } from '@businessos/calendar';
import { commerceTimelineProjectors } from '@businessos/commerce';
import { formsTimelineProjectors } from '@businessos/forms';
import { communicationsTimelineProjectors } from '@businessos/communications';
import { crmTimelineProjectors } from '@businessos/crm';
import { createNotificationSubscriber, type NotificationServices } from '@businessos/notifications';
import type { Database } from '@businessos/database';
import { SubscriberRegistry } from '@businessos/events';

/**
 * Event subscribers. The activity timeline projects CRM, messaging, appointment, form, quote and
 * invoice events; automation starts workflow runs from trigger events; notifications reach the
 * members concerned. Outbound webhooks register here in their own phase.
 */
export function createSubscriberRegistry(
  db: Database,
  automation?: AutomationServices,
  notifications?: NotificationServices,
): SubscriberRegistry {
  const registry = new SubscriberRegistry().register(
    createTimelineSubscriber(db, {
      ...crmTimelineProjectors,
      ...communicationsTimelineProjectors,
      ...calendarTimelineProjectors,
      ...formsTimelineProjectors,
      ...commerceTimelineProjectors,
    }),
  );
  // Workflow triggers (needs the job queue to start runs).
  if (automation) registry.register(createAutomationSubscriber(db, automation));
  // Member notifications (needs the job queue for emails).
  if (notifications) registry.register(createNotificationSubscriber(notifications));
  return registry;
}
