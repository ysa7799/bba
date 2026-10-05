import { createTimelineSubscriber } from '@businessos/activities';
import { createAutomationSubscriber, type AutomationServices } from '@businessos/automation';
import { calendarTimelineProjectors } from '@businessos/calendar';
import { commerceTimelineProjectors } from '@businessos/commerce';
import { formsTimelineProjectors } from '@businessos/forms';
import { communicationsTimelineProjectors } from '@businessos/communications';
import { crmTimelineProjectors } from '@businessos/crm';
import type { Database } from '@businessos/database';
import { SubscriberRegistry } from '@businessos/events';

/**
 * Event subscribers. The activity timeline projects CRM, messaging, appointment, form, quote and
 * invoice events; automation starts workflow runs from trigger events. Notifications and
 * outbound webhooks register here in their own phases.
 */
export function createSubscriberRegistry(
  db: Database,
  automation?: AutomationServices,
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
  return registry;
}
