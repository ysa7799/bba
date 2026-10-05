import { createTimelineSubscriber } from '@businessos/activities';
import { crmTimelineProjectors } from '@businessos/crm';
import type { Database } from '@businessos/database';
import { SubscriberRegistry } from '@businessos/events';

/**
 * Event subscribers. The activity timeline projects CRM events (Phase 9); notifications,
 * outbound webhooks and automation register here in their own phases.
 */
export function createSubscriberRegistry(db: Database): SubscriberRegistry {
  return new SubscriberRegistry().register(createTimelineSubscriber(db, crmTimelineProjectors));
}
