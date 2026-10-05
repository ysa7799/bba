import { createTimelineSubscriber } from '@businessos/activities';
import { communicationsTimelineProjectors } from '@businessos/communications';
import { crmTimelineProjectors } from '@businessos/crm';
import type { Database } from '@businessos/database';
import { SubscriberRegistry } from '@businessos/events';

/**
 * Event subscribers. The activity timeline projects CRM and messaging events; notifications,
 * outbound webhooks and automation register here in their own phases.
 */
export function createSubscriberRegistry(db: Database): SubscriberRegistry {
  return new SubscriberRegistry().register(
    createTimelineSubscriber(db, { ...crmTimelineProjectors, ...communicationsTimelineProjectors }),
  );
}
