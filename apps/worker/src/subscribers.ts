import { SubscriberRegistry } from '@businessos/events';

/**
 * Event subscribers. Notifications, outbound webhooks, automation and the activity timeline
 * register here in their own phases.
 */
export function createSubscriberRegistry(): SubscriberRegistry {
  return new SubscriberRegistry();
}
